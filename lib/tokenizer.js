/**
 * @typedef {Object} Token
 * @property {string} name
 * @property {string} match
 * @property {number} start
 * @property {number} end
 * 
 * @callback TokenGeneratorFunction A function that matches for a token
 * @param {string} str The string this generator is to work on
 * @returns {{ length: number, [key: string]: any } | void} The length of this capture + any extra metadata to append to this token
 * 
 * @typedef {TokenGeneratorFunction | RegExp} TokenGenerator
 */

/**
 * A tool to parse out the tokens of a string
 */
class Tokenizer {
    static colors = ['\x1b[41m', '\x1b[42m', '\x1b[43m', '\x1b[44m', '\x1b[45m', '\x1b[46m'];
    /**
     * @param {string} str The string to tokenize
     * @param {{ [key: string]: TokenGenerator }} tokens The indevidual kinds of tokens and there matchers
     */
    constructor(str, tokens, debug = false) {
        this.debug = debug && !nostd;
        if (this.debug) {
            let i = 0;
            this.colors = Object.fromEntries(Object.keys(tokens)
                .map(name => [name, Tokenizer.colors[i++ % Tokenizer.colors.length]]));
        }
        this.length = str.length;
        this.str = '\n' + str + '\n';
        this.idx = 0;
        this.matches = null;
        this.tokens = Object.fromEntries(Object.entries(tokens)
            .map(([name, func]) => {
                if (func instanceof RegExp)
                    return [
                        name,
                        str => {
                            const match = func.exec(str);
                            if (!match || match.index !== 0) return;
                            if (!match.groups) return { length: match[0].length }
                            return {
                                length: match[0].length,
                                ...match.groups
                            }
                        }
                    ];
                if (typeof func !== 'function')
                    throw new TypeError(`Invalid token ${name}: Tokens can ONLY be typeof function or RegExp, got ${typeof func} instead.`);
                return [name, func];
            }));
    }

    getTokens() { 
        if (!this.debug && !nostd) {
            process.stdout.write(`Tokenising file data.\n`);
            process.stdout.write(`[${' '.repeat(process.stdout.columns -2)}]`);
        }
        if (!this.matches) {
            this.matches = [];
            for (const name in this.colors) 
                process.stdout.write(`${this.colors[name]}${name}\x1b[0m\n`);
            for (; this.str.length; this.idx++) {
                if (!this.debug && !nostd) {
                    const width = process.stdout.columns -2;
                    const percent = Math.min(Math.round((this.idx / this.length) * 100), 100);
                    const barLen = Math.round((this.idx / this.length) * width);
                    const perStr = percent.toString() + '%';
                    const perLoc = Math.ceil(((width / 2) +1) - (perStr.length / 2));
                    if (barLen < 0)
                        console.log('FUCK');
                    const bar = `\x1b[0G[${'='.repeat(Math.min(Math.max(barLen, 0), Math.max(width, 8)))}${' '.repeat(Math.min(Math.max(width - barLen, 0), Math.max(width, 8)))}]`;
                    process.stdout.write(bar.slice(0, perLoc) + perStr + bar.slice(perLoc + perStr.length));
                }
                const tok = this.match();
                if (tok) {
                    this.matches.push(tok);
                    continue;
                }
                if (this.debug) process.stdout.write(this.str[0]);
                this.str = this.str.slice(1);
            }
        }
        if (!this.debug && !nostd)
            process.stdout.write(`\x1b[0G${' '.repeat(process.stdout.columns)}\x1b[0G\x1b[A${' '.repeat(process.stdout.columns)}\x1b[0G`);
        return this.matches; 
    }
    _getGroup(grouping, idx = 0) {
        const g = grouping
            .map(name => '?*^'.includes(name[0]) 
                ? [name.slice(1), name[0]] 
                : [name, '']);
        const matched = [];
        let i = 0;
        const tokens = this.getTokens().slice(i);
        for (; idx < tokens.length; idx++ ) {
            const token = tokens[idx];
            matched.push(token);

            switch (g[i][1]) {
            default: 
                if (token.name !== g[i][0]) return;
                i++;
                break;
            case '?':
                // rerun next
                if (token.name !== g[i][0]) {
                    matched.pop();
                    i++;
                    idx--;
                    continue;
                }
                i++;
                break;
            case '*':
                // rerun next (eval in cascading fashion)
                if (g[i][0] && token.name !== g[i][0] ||
                    (!g[i][0] && token.name === g[i +1][0])
                ) {
                    matched.pop();
                    i++;
                    idx--;
                    continue;
                }
                break;
            case '^': {
                const inner = [];
                for (; idx < tokens.length; idx++) {
                    const group = this._getGroup(grouping, idx);
                    if (!group) {
                        if (g[i +1] && tokens[idx].name === g[i +1][0]) break;
                        continue;
                    }
                    inner.push(group[1]);
                    idx = group[0];
                }
                matched.pop();
                i++;
                idx--;
                matched.push(inner);
                break;
            }
            }
            if (i >= g.length) {
                if (this.debug) {
                    process.stdout.write('\n------------\x1b[1mTOKEN GROUP\x1b[0m------------\n');
                    for (const tok of matched.flat(Infinity))
                        process.stdout.write(`${tok.name} { ${Object.entries(tok).filter(([key, val]) => !['length', 'name', 'start', 'end', 'match'].includes(key) && (typeof (val ?? undefined) !== 'undefined')).map(([key, val]) => `\x1b[90m${key}:\x1b[0m ${val}`).join(', ')} }\n`);
                }
                return [idx, matched];
            }
        }
    }
    getGroups(grouping) {
        const groups = [];
        for (let i = 0; i < this.getTokens().length; i++) {
            const group = this._getGroup(grouping, i);
            if (!group) continue;
            groups.push(group[1]);
            i = group[0];
        }
        return groups;
    }
    /**
     * 
     * @param {string} name
     * @returns {Token}
     */
    _callToken(name) {
        const func = this.tokens[name];
        const res = func.apply(this, [this.str]);
        // WHAT THE FUCK, WHY IS null AN OBJECT
        if (typeof (res ?? undefined) !== 'object') return;
        const match = this.str.slice(0, res.length);
        if (this.debug) 
            process.stdout.write(this.colors[name] + this.str.slice(0, res.length) + '\x1b[0m');
        this.str = this.str.slice(res.length);
        const start = Math.max(this.idx -1, 0);
        this.idx += Math.max(res.length -1, 0);
        delete res.length;
        return {
            name,
            start,
            end: this.idx,
            match,
            ...res
        };
    }
    match() {
        for (const name of Object.keys(this.tokens)) {
            const tok = this._callToken(name);
            if (tok) return tok;
        }
    }
}

module.exports = Tokenizer;
