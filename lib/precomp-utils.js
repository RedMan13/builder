const fs = require('fs/promises');
const path = require('path');
const Tokenizer = require('./tokenizer');
const { jumpArbit } = require('./js-helpers');
// note: i will be adding things to this as *i* need them, not as they may be needed
class PrecompUtils {
    constructor(path, file, manager, forced = false) {
        this.force = forced;
        this.path = path;
        this.file = file.toString('utf8');
        this.binnary = /[\x00\x1F]/gi.test(file);
        if (!this.binnary) {
            this.file = this.file.replaceAll(/\r?\n\r?/gi, '\n');
            this.makeLines();
        } else this.file = file;
        this.insertions = [];
        this.manager = manager;
    }
    makeLines() {
        let idx = 0;
        this.lines = this.file
            .split('\n')
            .map(line => {
                const lineIdx = idx;
                idx += line.length +1;
                return [lineIdx, line];
            });
            
    }
    /**
     * Matches all js structures that have arbitrary and irrelavent contents
     * @param {string} str The string to check (only checks from start)
     * @returns {number} the length of the match
     */
    jumpArbit = jumpArbit;
    tokenize(tokens, filter, debug) {
        const tok = new Tokenizer(this.file, tokens, debug);
        if (filter) {
            this.tokens = tok.getGroups(filter);
            return;
        }
        this.tokens = tok.getTokens();
    }
    findLine(idx) {
        const lineIdx = this.lines.findIndex(line => idx < line[0]) -1;
        const line = this.lines[lineIdx];
        return [...line, lineIdx];
    }
    getTokenRef(token) {
        const line = this.findLine(token.start);
        if (!line) return `${token.name} (unknown location)`;
        const col = token.start - line[0];
        return `${token.name} "${token.match}" (at L${line[2] +1}:C${col +1} of ${this.path})`
    }

    get buildDir() { return this.manager.buildDir }
    get entry() { return this.manager.entry }
    getFile(pathTo, force) {
        pathTo = path.resolve(pathTo);
        this.manager.depends[pathTo] ??= [];
        if (!this.manager.depends[pathTo].includes(this.path))
            this.manager.depends[pathTo].push(this.path);
        force ??= this.force;
        return this.manager.getFile(pathTo, force);
    }
    insert(idx, str) {
        this.replace(idx, idx, str);
    }
    replace(start, end, str) {
        this.insertions.push({
            start,
            end,
            text: str
        });
    }
    matchType(types) {
        const typeList = types
            .split(',')
            .map(type => type[0] === '.' ? type : `.${type}`)
        return !!typeList.find(type => this.path.endsWith(type));
    }
    async bake(outputDir) {
        let offset = 0;
        for (const { start, end, text } of this.insertions) {
            const left = this.file.slice(0, start + offset);
            const right = this.file.slice(end + offset);
            this.file = left + text + right;
            offset += text.length - (end - start);
        }
        this.insertions = [];
        this.makeLines();

        if (outputDir) {
            const name = this.path.replace(this.manager.entry, '');
            const baseName = path.basename(name);
            const endPath = path.resolve(outputDir, name);
            this.path = endPath;
            const folderPath = endPath.slice(0, -baseName.length);
            await fs.mkdir(folderPath, { recursive: true });
            await fs.writeFile(endPath, this.file);
        }
    }
}

module.exports = PrecompUtils