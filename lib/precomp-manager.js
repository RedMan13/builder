const PrecompUtils = require('./precomp-utils');
const { resolveImport } = require('./mjs-helpers');
// const Client = require('ssh2-sftp-client');
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
    constructor(buildDir = 'dist', sftpServerIP, sftpUser, sftpLogin) {
        /** @type {Precomp[]} */
        this.server = null;
        this.precomps = [];
        this.built = {};
        this.depends = {};
        this.isIgnored = /./;
        this.buildDir = sftpServerIP ? buildDir : path.resolve(buildDir);
        globalThis.buildDir = this.buildDir;
        this.entry = path.resolve('.') + '/';
        this.makeIgnored();
        this.getPrecomps();
        /*
        if (sftpServerIP) {
            this.server = new Client();
            this.server.connect({
                host: sftpServerIP,
                username: sftpUser,
                password: sftpLogin
            });
        }
        */
    }
    async makeIgnored() {
        const ignoreList = (await fs.readFile('.buildignore', { encoding: 'utf8' }))
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
                ].join('|');
        const rootMatch = this.entry.replaceAll('\\', '\\\\').slice(0, -1);
        this.isIgnored = new RegExp(`${rootMatch}(?:\\\\|/)(?:${ignoreList})`, 'i');
    }
    async getPrecomps() {
        console.log('\ngetting precomps');
        this.precomps = (await fs.readdir('./preprocessors'))
            .filter(filePath => filePath.endsWith('.precomp.js'))
            .map(filePath => {
                /** @type {Precomp} */
                const precomp = require(path.resolve('preprocessors', filePath));
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
    isBuilt(target) {
        return !!this.built[path.resolve(target)];
    }
    async getFile(target, force) {
        target = path.resolve(target);
        if (!force && this.isBuilt(target)) 
            return [
                this.built[target],
                await fs.readFile(this.built[target], 'utf8'),
                false
            ];
        if (target.startsWith(this.buildDir))
            return [
                target,
                await fs.readFile(target, 'utf8'),
                false
            ];
        const file = new PrecompUtils(
            target, 
            await fs.readFile(target, 'utf8'), 
            this,
            force
        );
        if (this.isIgnored.test(file.path))
            return [file.path, file.file, true];
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
            await file.bake();
            if (file.skip) // this precomp decided that the file needs to be ignored
                return [file.path, file.file, true];
        }
        await file.bake(this.buildDir);
        this.built[target] = file.path;
        return [
            file.path,
            file.file,
            false
        ];
    }
    async buildAll() {
        if (await this.exists(this.buildDir)) {
            console.log('removing old build dir');
            await fs.rm(this.buildDir, { recursive: true, force: true });
        }
        await fs.mkdir(this.buildDir);
        this.built = {};
        this.asoc = {};
        const files = await fs.readdir('.', { recursive: true });
        const toAddFileList = [];
        console.log('\nbuilding all files');
        for (const path of files) {
            const stat = await fs.stat(path).catch(() => false);
            if (!stat) continue;
            if (stat.isDirectory()) continue;
            if (path.startsWith('node_modules')) continue;
            const [res, data, skipped] = await this.getFile(path);
            if (data.includes('"filejson"') && !skipped) toAddFileList.push(res);
        }
        
        console.log('\nmaking page browser from built');
        const fileJson = JSON.stringify(await this.recursiveRead());
        for (const path of toAddFileList) {
            const data = await fs.readFile(path, 'utf8').catch(() => null);
            if (!data) continue;
            await fs.writeFile(path, data.replace('"filejson"', fileJson));
        }
        console.log('finnished building');
    }
    /** @returns {BrowserFolder} */
    async recursiveRead(dir = this.buildDir) {
        const dirs = await fs.readdir(dir);
        /** @type {BrowserFolder} */
        const folder = {
            name: path.basename(dir),
            icon: null,
            members: [],
            pages: 0
        };
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
            if (extName === '.php' || extName === '.html') {
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
