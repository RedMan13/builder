const Tokenizer = require('./tokenizer');
const path = require('path');

/**
 * Matches all js structures that have arbitrary and irrelavent contents
 * @param {string} str The string to check (only checks from start)
 * @returns {number} the length of the match
 */
function jumpArbit(str) {
    const match = str.match(/^\s*('(\\'|[^'\n])*'|"(\\"|[^"\n])*"|`(\\`|\\\$|[^`$])*`|\/\/[^\n]*|\/\*(\*.|[^*])*?\*\/|\/([^\/\n]|\\\/)*\/[a-z]*)\s*/is);
    if (match) return match[0].length;
    if (str[0] !== '`') return 0;
    let indent = 0;
    let inJs = false;
    for (let i = 1; i < str.length; i++) {
        if (inJs) {
            const jmp = jumpArbit(str.slice(i));
            if (jmp) {
                i += jmp -1;
                continue;
            }
        }
        if (str[i -1] === '\\') continue;
        if (!inJs && str[i] === '`') return i +1;
        if (str[i] === '$') inJs = true;
        if (str[i] === '{') indent++;
        if (str[i] === '}') {
            indent--;
            if (inJs && indent === 0) inJs = false;
        }
    }
    return 0;
}
module.exports.jumpArbit = jumpArbit;

const matchString = /^\s*('(\\'|[^'\n])*'|"(\\"|[^"\n])*")\s*/;
const stringEscapes = /\\x[0-9a-fA-F][0-9a-fA-F]|\\u[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]|\\u{[0-9a-fA-F]+}|\\c[a-zA-Z]|\\./g;
function handleEscape(escape) {
    switch (escape[1]) {
    case 'x': return String.fromCharCode(parseInt(escape.slice(2), 16));
    case 'u': 
        if (escape[2] === '{') escape = `01${escape.slice(3, -1)}`;
        return String.fromCharCode(parseInt(escape.slice(2), 16));
    case 'c': return String.fromCharCode(escape[3].charCodeAt(0) % 32);
    }
}
/**
 * Parses the actual data out of a given js string
 * @param {string} str what to extract from
 * @returns {string} the extracted data
 */
function parseStringAt(str) {
    const match = matchString.exec(str);
    if (!match) return;
    const content = match[1].slice(1, -1);
    return content.replace(stringEscapes, handleEscape);
}
module.exports.parseStringAt = parseStringAt;
const varName = /[_$a-z][_$a-z0-9]*/i;
function parseVarAt(str) {
    const match = /^(?<definer>(?:async\s*)?function\s*\*?|class|const|let|var)\s+(?<names>.*?)[;{\[()}]/.exec(str)?.groups;
    if (!match) return;
    match.definer = match.definer.replaceAll(' ', '');
    switch (match.definer.replaceAll(' ', '')) {
    case 'asyncfunction':
    case 'asyncfunction*':
    case 'function':
    case 'function*':
    case 'class':
        return [match.definer, [match.names]];
    case 'const':
    case 'let':
    case 'var':
        /** @type {string[]} */
        const parts = match.names.split(/,\s*/gi).map(str => str.trim());
        const names = [];
        for (let part of parts) {
            if (part[0] === '{' || part[0] === '[') 
                part = part.slice(1).trim();
            if (part.at(-1) === '}' || part.at(-1) === ']') 
                part = part.slice(0, -1).trim();
            if (!part) continue;
            if (varName.test(part)) { names.push(part); continue; }
            // super mega epic split from start function
            const [key, variable] = [...part]
                .reverse()
                .join('')
                .split(/\s*:/, 2)
                .reverse()
                .map(str => [...str]
                    .reverse()
                    .join('')
                );
            if (key) {
                if (!variable) { names.push(key); continue; }
                names.push(variable);
                continue;
            }
            const [varia] = part.split(/\s*=\s*/, 2);
            names.push(varia);
        }
        return ['var', names];
    }
}
/**
 * @param {string} data The MJS data to convert
 * @returns {string} The conversion result
 */
function toCJS(data) {
    const toks = new Tokenizer(data, {
        _(str) {
            const jmp = jumpArbit(str);
            return jmp ? { length: jmp } : null;
        },
        import(str) {
            if (!str.startsWith('import')) return;
            if (/^import\s*\(/.test(str)) return { length: 6, shim: true };
            if (/^import\s*\./.test(str)) return { length: 6, shim: true };
            const endLoc = str.indexOf(';');
            const withLoc = (str.indexOf('with') +1 || endLoc +1) +3;
            const withStr = str.slice(withLoc, endLoc).trim();
            const fromLoc = (str.indexOf('from') +1 || endLoc +1) +3;
            const fromStr = str.slice(fromLoc, withLoc -4).trim();
            const importLoc = str.indexOf('import') +6;
            const importStr = str.slice(importLoc, fromLoc -4).trim();
            if (matchString.test(importStr)) {
                return {
                    path: parseStringAt(importStr),
                    props: { type: 'js' },
                    imported: {},
                    length: strDat[0].length + importLoc
                }
            }
            const imported = {};
            let byKey = false;
            const commad = importStr.split(',').map(str => str.trim());
            for (let part of commad) {
                if (part[0] === '{') {
                    byKey = true;
                    part = part.slice(1).trim();
                }
                if (!part) continue;
                const match = /(?<name>[_$a-z][_$a-z0-9]*|\*)|(?<key>.*?)\s+as\s+(?<variable>[_$a-z][_$a-z0-9]*)/i.exec(part).groups;
                if (!byKey && match.key && match.key !== '*') return;
                const key = byKey
                    ? match.name 
                        ? match.name
                        : ['"', "'"].includes(match.key[0]) 
                            ? parseStringAt(match.key) 
                            : match.key 
                    : match.key 
                        ? 'all' 
                        : 'default';
                const variable = match.name ?? match.variable;
                imported[key] = variable;
                if (part.at(-1) === '}') {
                    byKey = false;
                    continue;
                }
            }
            const props = Object.fromEntries(withStr
                .slice(1, -1)
                .split(',')
                .filter(Boolean)
                .map(str => str.trim().split(/:\s*/))
                .map(([key, val]) => [key, parseStringAt(val)]));
            const file = parseStringAt(fromStr);
            props.type ??= path.extname(file).slice(1);
            return {
                path: file,
                props,
                imported,
                length: endLoc
            }
        },
        export(str) {
            if (!str.startsWith('export') || str.startsWith('exports')) return;
            const afterExport = str.slice(6).trim();
            const whiteSpace = (str.length -6) - afterExport.length;
            const endLine = str.indexOf(';');
            const fromIdx = str.indexOf('from') < endLine ? str.indexOf('from') +4 : endLine;
            const fromStr = str.slice(fromIdx, endLine).trim();
            const fromPath = parseStringAt(fromStr);
            const exportedFrom = str.slice(6, fromIdx -4).trim();
            if (fromPath) {
                const imported = {};
                let byKey = false;
                const commad = exportedFrom.split(',').map(str => str.trim());
                for (let part of commad) {
                    if (part[0] === '{') {
                        byKey = true;
                        part = part.slice(1).trim();
                    }
                    if (!part) continue;
                    const match = /(?<name>[_$a-z][_$a-z0-9]*|\*)|(?<key>.*?)\s+as\s+(?<variable>[_$a-z][_$a-z0-9]*)/i.exec(part).groups;
                    if (!byKey && match.key && match.key !== '*') return;
                    const key = byKey 
                        ? match.name 
                            ? match.name
                            : ['"', "'"].includes(match.key[0]) 
                                ? parseStringAt(match.key) 
                                : match.key  
                        : (match.key ?? match.name) === '*'
                            ? 'all' 
                            : 'default';
                    const variable = match.name ?? match.variable;
                    imported[key] = variable === '*' ? true : variable;
                    if (part.at(-1) === '}') {
                        byKey = false;
                        continue;
                    }
                }
                return {
                    exported: imported,
                    imports: fromPath,
                    length: endLine
                }
            }
            if (afterExport.startsWith('default')) {
                return {
                    exported: { default: true },
                    length: whiteSpace +13
                }
            }
            if (afterExport.startsWith('{')) {
                const endLoc = afterExport.indexOf('}');
                const exportTable = afterExport.slice(1, endLoc).trim();
                const exported = {};
                const commad = exportTable.split(',').map(str => str.trim());
                for (const part of commad) {
                    const match = /(?<name>[_$a-z][_$a-z0-9]*)|(?<variable>[_$a-z][_$a-z0-9]*)\s+as\s+(?<key>.*?)/i.exec(part).groups;
                    const key = match.name 
                        ? ['"', "'"].includes(match.name[0]) 
                            ? parseStringAt(match.name) 
                            : match.name 
                        : match.key ;
                    const variable = match.name ?? match.variable;
                    exported[key] = variable;
                }
                return {
                    exported,
                    length: str.indexOf('}') +1
                }
            }
            const [definer, names] = parseVarAt(afterExport);
            return {
                exported: Object.fromEntries(names.map(name => [name, name])),
                length: whiteSpace +6
            }
        }
    });
    const tokens = toks.getTokens().filter(tok => tok.name !== '_');
    let mVar = 0;
    let repOffset = 0;
    for (const tok of tokens) {
        let replace = '';
        switch (tok.name) {
        case 'import':
            const cont = `__TMP_MODULELOD${mVar++}`;
            replace += `const ${cont} = require(${JSON.stringify(tok.path)}, ${JSON.stringify(tok.props)}); `;
            if (tok.imported.default) {
                replace += `const ${tok.imported.default} = ${cont}; `;
            }
            for (const [keyName, variable] of Object.entries(tok.imported).filter(([keyName]) => keyName !== 'default'))
                replace += `const ${variable} = ${cont}[${JSON.stringify(keyName)}];`;
            break;
        case 'export':
            if (tok.exported.default) {
                replace += 'const defaultExport = ';
                data += `module.exports = Object.assign(defaultExport, module.exports); `
            }
            for (const [key, variable] of Object.entries(tok.exported))
                data += `module.exports[${key}] = ${variable};`;
            break;
        }
        const left = data.slice(0, tok.start + repOffset);
        const right = data.slice(tok.end + repOffset);
        data = left + replace + right;
        repOffset += replace.length - (tok.end - tok.start)
    }
    const imported = tokens
        .filter(tok => tok.name === 'import')
        .map(imp => [imp.path, imp.props]);
    return [imported, data];
}
module.exports.toCJS = toCJS;
function getCJSRequired(data) {
    const toks = new Tokenizer(data, {
        _(str) {
            const jmp = jumpArbit(str);
            return jmp ? { length: jmp } : null;
        },
        require: /require\((.*?)\)/
    });
    return toks.getTokens()
        .filter(tok => tok.name !== '_')
        .map(tok => parseStringAt(tok.path))
        .filter(Boolean)
        .map(file => [file, { type: path.extname(file).slice(1) }]);
}
module.exports.getCJSRequired = getCJSRequired;