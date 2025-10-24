const PrecompUtils = require('./precomp-utils');
const xmlEscape = require('./xml-escape');
const fs = require('fs/promises');
const path = require('path');
/** 
 * @typedef {(utils: PrecompUtils) => void} Precomp 
 * @property {(utils: PrecompUtils) => boolean} Precomp.matchFile
 * @property {string} Precomp.[title]
 * @property {number} Precomp.[weight]
 */
/**
 * @typedef {object} BrowserFile - a file in the browser menu
 * @property {string} name - the name of this file
 * @property {string?} icon - the url to the image to use as an icon for this file
 * @property {number?} sort - the sorting order of this element
 * @property {boolean?} selected - if this file in particular is selected
 * @property {string} resolve - the url to redirect to once this file is selected
 */
/**
 * @typedef {object} BrowserFolder - a folder in the browser menu
 * @property {string} name - the name of this file
 * @property {string?} icon - the url to the image to use as an icon for this folder, defaults to open-close arrows when unset
 * @property {number?} sort - the sorting order of this element
 * @property {boolean?} selected - if this file in particular is selected
 * @property {string} resolve - the url to redirect to once this file is selected
 * @property {number?} pages - the number of pages inside this folder
 * @property {Array<BrowserFolder|BrowserFile>} members - the files and folders underneith this folder
 */

class PrecompManager {
    /**
     * @param {string?} buildDir the folder to output all built data
     */
    constructor(buildDir = 'dist', copyModules = true) {
        this.server = null;
        this.remotePath = null;
        /** @type {Precomp[]} */
        this.precomps = [];
        this.built = {};
        this.depends = {};
        this.isIgnored = /./;
        this.copyModules = copyModules;
        this.buildDir = path.resolve(buildDir) + '/';
        globalThis.buildDir = this.buildDir;
        this.entry = path.resolve('.') + '/';
        this.makeIgnored();
        this.getPrecomps();
    }
    async makeIgnored() {
        const ignoreList = (await fs.readFile(path.resolve(this.entry, '.buildignore'), { encoding: 'utf8' }))
            .replaceAll(/\r?\n\r?/gi, '|')
            .replaceAll('/', '(?:\\\\|/)')
                + '|' + [
                    this.buildDir.replace(this.entry, '').replace('.', '\\.'),
                    /\.gitignore/.source,
                    /preprocessors/.source,
                    /\.buildignore/.source,
                    /\.git/.source,
                    /package-lock\.json/.source,
                    /package\.json/.source,
                    /node_modules/.source,
                ].join('|');
        const rootMatch = this.entry.replaceAll('\\', '\\\\').slice(0, -1);
        this.isIgnored = new RegExp(`${rootMatch}(?:\\\\|/)(?:${ignoreList})`, 'i');
    }
    async getPrecomps() {
        console.log('\ngetting precomps');
        this.precomps = (await fs.readdir(path.resolve(this.entry, './preprocessors')))
            .filter(filePath => filePath.endsWith('.precomp.js'))
            .map(filePath => {
                /** @type {Precomp} */
                const precomp = require(path.resolve(this.entry, 'preprocessors', filePath));
                precomp.title = path.basename(filePath).replace('.precomp.js', '');
                return precomp;
            })
            .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
            .map(precomp => (console.log('\tprecomp', precomp.title), precomp));
        
    }
    exists(target) {
        return fs.stat(target)
            .then(() => true)
            .catch(() => false);
    }
    getBuilt(target) {
        target = path.resolve(this.entry, target);
        if (this.built[target]) return this.built[target];
        const found = Object.entries(this.built)
            .find(([key, val]) => val.replace(this.buildDir, this.entry.slice(0, -1)) === target ||
                val === target);
        if (found) return found[1];
    }
    isBuilt(target) {
        return !!this.getBuilt(target);
    }
    async getFile(target, force) {
        target = path.resolve(this.entry, target);
        if (!force && this.isBuilt(target)) 
            return [
                this.getBuilt(target),
                await fs.readFile(this.getBuilt(target), 'utf8'),
                false
            ];
        if (target.startsWith(this.buildDir))
            return [
                target,
                await fs.readFile(target, 'utf8'),
                false
            ];
        // we dont actually know where its going to go yet, but circularity is unresolvable recursively otherwise
        this.built[target] = target.replace(this.entry, this.buildDir);
        await fs.mkdir(path.dirname(this.built[target]), { recursive: true });
        await fs.writeFile(this.built[target], '');
        const file = new PrecompUtils(
            target, 
            await fs.readFile(target, 'utf8'), 
            this,
            force
        );
        if (file.skip) // one of the match file ops tells us to ignore this file
            return [file.path, file.file, true];
        if (file.binnary) {
            const name = target.replace(this.entry, '');
            const endPath = path.resolve(this.buildDir, name);
            const content = await fs.readFile(target);
            await fs.mkdir(path.dirname(endPath), { recursive: true });
            await fs.writeFile(endPath, content);
            return [endPath, content, true];
        }
        console.log('\tbuilding', target.replace(this.entry, ''));
        for (const precomp of this.precomps) {
            if (!precomp.matchFile(file)) continue;
            console.log('\t\tapplying precomp', precomp.title);
            await precomp(file);
            if (file.skip) // this precomp decided that the file needs to be ignored
                return [file.path, file.file, true];
            await file.bake();
        }
        await file.bake(this.buildDir);
        // our guess was wrong, cleanup now incorrect files
        if (file.path !== this.built[target])
            fs.rm(this.built[target]);
        this.built[target] = file.path;
        return [
            file.path,
            file.file,
            false
        ];
    }
    async buildAll(clearOld = true) {
        if (clearOld) {
            if (await this.exists(this.buildDir)) {
                console.log('removing old build dir');
                await fs.rm(this.buildDir, { recursive: true, force: true });
            }
            await fs.mkdir(this.buildDir).catch(() => {});
            this.built = {};
            this.depends = {};
            if (this.copyModules) {
                console.log('\ncopying node_modules');
                const modules = await fs.readdir(path.resolve(this.entry, './node_modules'), { recursive: true });
                for (let i = 0, module = modules[0]; i < modules.length; module = modules[++i]) {
                    const file = path.resolve(this.entry, 'node_modules', module);
                    if (module.split('/').length <= 1) {
                        const packageJson = JSON.parse(await fs.readFile(path.resolve(file, 'package.json'), 'utf8').catch(() => 'null'));
                        if (packageJson) {
                            packageJson.type = 'commonjs'; // rewrite to commonjs to match build casting
                            await fs.writeFile(path.resolve(file, 'package.json'), JSON.stringify(packageJson));
                        }
                    }
                    const stat = await fs.stat(file).catch(() => false);
                    if (!stat) continue;
                    if (stat.isDirectory()) continue;
                    const per = i / modules.length;
                    const width = process.stdout.columns -2;
                    const barLen = Math.round(per * width);
                    const perStr = `${Math.floor(per * 100)}%`;
                    const perLoc = Math.ceil(((width / 2) +1) - (perStr.length / 2));
                    if (barLen < 0)
                        console.log('FUCK');
                    const bar = `\x1b[0G[${'='.repeat(Math.min(Math.max(barLen, 0), Math.max(width, 8)))}${' '.repeat(Math.min(Math.max(width - barLen, 0), Math.max(width, 8)))}]`;
                    process.stdout.write(bar.slice(0, perLoc) + perStr + bar.slice(perLoc + perStr.length));
                    await fs.mkdir(path.resolve(this.buildDir, 'node_modules', module, '..'), { recursive: true });
                    await fs.copyFile(file, path.resolve(this.buildDir, 'node_modules', module));
                }
            }
        }
        const files = await fs.readdir(this.entry, { recursive: true });
        const toAddFileList = [];

        console.log('\nbuilding all files');
        for (const name of files) {
            const file = path.resolve(this.entry, name);
            if (this.isIgnored.test(file)) continue;
            const stat = await fs.stat(file).catch(() => false);
            if (!stat) continue;
            if (stat.isDirectory()) continue;
            const [res, data, skipped] = await this.getFile(file);
            if (data.includes('{filejson}') && !skipped) toAddFileList.push(res);
        }
        
        console.log('\nmaking page browser from built');
        const fileJson = xmlEscape(JSON.stringify(await this.recursiveRead()));
        for (const path of toAddFileList) {
            const data = await fs.readFile(path, 'utf8').catch(() => null);
            if (!data) continue;
            await fs.writeFile(path, data.replaceAll('{filejson}', fileJson));
        }

        console.log('finnished building');
    }
    /** @returns {BrowserFolder} */
    async recursiveRead(dir = this.buildDir) {
        const dirs = await fs.readdir(dir).catch(err => null);
        /** @type {BrowserFolder} */
        const folder = {
            name: path.basename(dir),
            icon: null,
            members: [],
            pages: 0
        };
        if (!dirs) return folder;
        for (const file of dirs) {
            if (file.startsWith('.')) continue;
            const target = path.resolve(dir, file);
            const stat = await fs.stat(target).catch(() => null);
            if (!stat) continue;
            if (stat.isDirectory()) {
                const subFolder = await this.recursiveRead(target, true);
                if (!Object.keys(subFolder.members).length) continue;
                folder.pages += subFolder.pages;
                folder.members.push(subFolder);
                continue;
            }
    
            const extName = path.extname(file);
            if (extName === '.php' || extName === '.html' || extName === '.server.js') {
                const content = await fs.readFile(target, 'utf8');
                const title = content.match(/<title>(.*?)<\/title>/i)?.[1] ?? file;
                const icon = content.match(/<link\s+rel="icon"\s*href="(.*?)"\s*type=".*?"\s*\/?>/)?.[1] ?? '/favicon.ico';
                const depPath = content.split(/<!TEMPLATE |>\r?\n\r?/, 3)[1];
                const resolve = target.replace(this.buildDir, '')
                if (depPath === '/cardpage.html') folder.pages++;
                console.log('\tadding', (depPath === '/cardpage.html' ? 'page' : 'file'), resolve, 'to index.json');
                folder.members.push({
                    name: title,
                    icon,
                    resolve
                });
            }
        }
        return folder;
    }
}

module.exports = PrecompManager;
