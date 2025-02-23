const Tokenizer = require('./tokenizer');
const path = require('path');
const fs = require('fs');
const { captures: { imported, requires }, resolveImport } = require('./mjs-helpers');

/**
 * Matches all js structures that have arbitrary and irrelavent contents
 * @param {string} str The string to check (only checks from start)
 * @returns {number} the length of the match
 */
function jumpArbit(str) {
    const match = str.match(/^('(\\'|[^'\n])*'|"(\\"|[^"\n])*"|`(\\`|\\\$|[^`$])*`|\/\/[^\n]*|\/\*(\*.|[^*])*?\*\/|\/([^\/\n]|\\\/)*\/[a-z]*)/is);
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
const varName = /^[_$a-z][_$a-z0-9]*$/i;
function parseVarAt(str) {
    const match = /^(?<definer>(?:async\s*)?function\s*\*?|class|const|let|var)\s+(?<names>.*?)[;{\[()}]/s.exec(str)?.groups;
    if (!match) 
        return;
    match.definer = match.definer.replaceAll(' ', '');
    match.names = match.names.trim();
    switch (match.definer.replaceAll(' ', '')) {
    case 'asyncfunction':
    case 'asyncfunction*':
    case 'function':
    case 'function*':
    case 'class':
        return [match.definer, [match.names.split(/\s+/g, 2)[0].match(varName)?.[0] ?? match.names]];
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
            // super mega epic split from end function
            const [key, variable] = [...part]
                .reverse()
                .join('')
                .split(/\s*:/, 2)
                .reverse()
                .map(str => [...str]
                    .reverse()
                    .join('')
                );
            const [varia, value] = part.split(/\s*=\s*/, 2);
            if (!key.includes('=')) {
                if (!variable) { names.push(key); continue; }
                names.push(variable);
                continue;
            } else names.push(varia);
        }
        return ['var', names];
    }
}
function parseKeyAs(str, flip = false) {
    str = str.trim();
    const pairs = {};
    let byKey = false;
    let closeKeys = false;
    const commad = str.split(',').map(str => str.trim());
    for (let part of commad) {
        if (part[0] === '{') {
            byKey = true;
            part = part.slice(1).trim();
        }
        if (part.at(-1) === '}') {
            closeKeys = true;
            part = part.slice(0, -1).trim();
        }
        if (!part) continue;
        const match = flip 
            ? /(?<variable>[_$a-z][_$a-z0-9]*|\*)\s+as\s+(?<key>.*?)$|(?<name>[_$a-z][_$a-z0-9]*|\*)/i.exec(part).groups
            : /(?<key>.*?)\s+as\s+(?<variable>[_$a-z][_$a-z0-9]*)|(?<name>[_$a-z][_$a-z0-9]*)/i.exec(part).groups;
        if (!byKey && match.key && match.key !== '*') return;
        const key = byKey
            ? match.name 
                ? flip 
                    ? match.name === '*' ? 'all' : match.name
                    : match.name
                : ['"', "'"].includes(match.key[0]) 
                    ? parseStringAt(match.key) 
                    : match.key 
            : match.key === '*'
                ? 'all' 
                : 'default';
        const variable = match.name === '*' 
            ? true 
            : (match.name ?? (match.variable === '*' 
                ? 'all' 
                : match.variable));
        pairs[key] = variable;
        if (closeKeys) closeKeys = byKey = false;
    }
    return pairs;
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
            if (!/^\n\s*import\s+[^=]/s.test(str)) return;
            const len = str.length - str.trim().length;
            if (/^import\s*\(/.test(str)) return { length: len +6, shim: true };
            if (/^import\s*\./.test(str)) return { length: len +6, shim: true };
            str = str.trim();
            const endLoc = str.indexOf(';') !== -1 ? str.indexOf(';') : str.indexOf('\n');
            const withLoc = (str.indexOf(' with ') +1 || endLoc +1) +4;
            const withStr = str.slice(withLoc, endLoc).trim();
            const fromLoc = (str.indexOf(' from ') +1 || endLoc +1) +4;
            const fromStr = str.slice(fromLoc, withLoc -4).trim();
            const importLoc = str.indexOf('import ') +6;
            const importStr = str.slice(importLoc, fromLoc -4).trim();
            const props = Object.fromEntries(withStr
                .slice(1, -1)
                .split(',')
                .filter(Boolean)
                .map(str => str.trim().split(/:\s*/))
                .map(([key, val]) => [key, parseStringAt(val)]));
            const file = parseStringAt(fromStr) ?? parseStringAt(importStr);
            if (!file) 
                throw str.slice(0, 100);
            props.type ??= path.extname(file).slice(1);
            if (matchString.test(importStr)) {
                return {
                    path: file,
                    props,
                    imported: {},
                    length: endLoc + len
                }
            }
            const imported = parseKeyAs(importStr);
            if (!imported) return;
            return {
                path: file,
                props,
                imported,
                length: endLoc + len
            }
        },
        export(str) {
            if (!/^\n\s*export\s+[^=]/s.test(str)) return;
            const len = str.length - str.trim().length;
            str = str.trim();
            const afterExport = str.slice(6).trim();
            if (afterExport[0] === '=') return;
            const whiteSpace = ((str.length -6) - afterExport.length) + len;
            const endLine = str.indexOf(';');
            const withIdx = str.indexOf(' with ') < endLine && str.indexOf(' with ') > 0 
                ? str.indexOf(' with ') +5 
                : endLine +5;
            const withStr = str.slice(withIdx, endLine).trim();
            const fromIdx = str.indexOf(' from ') < withIdx && str.indexOf(' from ') > 0 
                ? str.indexOf(' from ') +5 
                : withIdx -5;
            const fromStr = str.slice(fromIdx, withIdx -4).trim();
            const fromPath = parseStringAt(fromStr);
            const exportedFrom = str.slice(6, fromIdx -4).trim();
            if (fromPath) {
                const imported = parseKeyAs(exportedFrom, true);
                if (!imported) return;
                const props = Object.fromEntries(withStr
                    .slice(1, -1)
                    .split(',')
                    .filter(Boolean)
                    .map(str => str.trim().split(/:\s*/))
                    .map(([key, val]) => [key, parseStringAt(val)]));
                props.type ??= path.extname(fromPath).slice(1);
                return {
                    exported: imported,
                    props,
                    imports: fromPath,
                    length: endLine + len
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
                const exportTable = afterExport.slice(0, endLoc +1);
                const exported = parseKeyAs(exportTable, true);
                if (!exported) return;
                return {
                    exported,
                    length: str.indexOf('}') + len +1
                }
            }
            const [definer, names] = parseVarAt(afterExport);
            return {
                exported: Object.fromEntries(names.map(name => [name, name])),
                length: len +6
            }
        }
    });
    const tokens = toks.getTokens().filter(tok => tok.name !== '_');
    let mVar = 0;
    let repOffset = 0;
    for (const tok of tokens) {
        let replace = '\n';
        switch (tok.name) {
        case 'import': {
            if (tok.shim) {
                replace = 'require';
                break;
            }
            const cont = `__TMP_MODULELOD${mVar++}`;
            replace += `const ${cont} = require(${JSON.stringify(tok.path)}, ${JSON.stringify(tok.props)}); `;
            if (tok.imported.default)
                replace += `const ${tok.imported.default} = ${cont};\n`;
            for (const [keyName, variable] of Object.entries(tok.imported).filter(([keyName]) => keyName !== 'default')) {
                if (keyName === 'all') {
                    replace += `const ${variable} = ${cont};\n`; continue; }
                if (keyName === 'default') {
                    replace += `const ${variable} = ${cont};\n`; continue; }
                replace += `const ${variable} = ${cont}[${JSON.stringify(keyName)}];\n`;
            }
            break;
        }
        case 'export': {
            if (typeof tok.exported.default === 'boolean') {
                replace += 'const defaultExport = ';
                data += `
for (const key in module.exports) defaultExport[key] = module.exports[key];
module.exports = defaultExport;\n`;
                break;
            }
            if (tok.imports) {
                const cont = `__TMP_MODULELOD${mVar++}`;
                data += `const ${cont} = require(${JSON.stringify(tok.imports)}); `;
                for (const [key, variable] of Object.entries(tok.exported)) {
                    if (variable === 'default' || variable === 'all') {
                        data += `\nmodule.exports[${JSON.stringify(key)}] = ${cont};\n`;
                        continue;
                    }
                    if (key === 'default' || key === 'all') {
                        data += `
for (const key in module.exports) ${variable}[key] = module.exports[key];
module.exports = ${variable};\n`;
                        continue;
                    }
                    data += `\nmodule.exports[${JSON.stringify(key)}] = ${cont}[${JSON.stringify(variable)}];\n`;
                }
                break;
            }
            for (const [key, variable] of Object.entries(tok.exported)) {
                if (key === 'default') {
                    data += `
for (const key in module.exports) ${variable}[key] = module.exports[key];
module.exports = ${variable};\n`;
                    continue;
                }
                data += `\nmodule.exports[${JSON.stringify(key)}] = ${variable};\n`;
            }
            break;
        }
        }
        const left = data.slice(0, tok.start + repOffset);
        const right = data.slice(tok.end + repOffset);
        data = left + replace + right;
        repOffset += replace.length - (tok.end - tok.start)
    }
    return data;
}
module.exports.toCJS = toCJS;
function getImported(data) {
    if (data.length >= 50000) {
        console.warn('File to large for proper tokenizing.');
        return [].concat(
            [...data.matchAll(new RegExp(requires.source, 'g'))]
                .map(m => parseStringAt(m.groups.module))
                .filter(Boolean),
            [...data.matchAll(new RegExp(imported.source, 'g'))]
                .map(m => parseStringAt(m.groups.module))
                .filter(Boolean)
        )
    }
    const toks = new Tokenizer(data, {
        _(str) {
            const jmp = jumpArbit(str);
            return jmp ? { length: jmp } : null;
        },
        requires, imported
    });
    return toks.getTokens()
        .filter(tok => tok.name !== '_')
        .map(tok => parseStringAt(tok.module))
        .filter(Boolean)
}
module.exports.getImported = getImported;
module.exports.getMJSImported = getImported;
module.exports.getCJSRequired = getImported;

async function getDeepFiles(file, manager, handled = {}) {
    if (handled[file]) return;
    handled[file] = true;
    console.log(`\t\t\ttraversing imports of ${path.relative(manager.entry, file)}`);
    
    let [real, data] = await manager.getFile(file);
    const ret = [[real, data]];
    const imports = getImported(data);
    for (const imported of imports) {
        const [_, imp, res] = await resolveImport(path.dirname(file), imported, manager);
        if (!fs.existsSync(res)) continue;
        data = data.replace(imported, imp);
        const files = await getDeepFiles(res, manager, handled);
        if (!files) continue;
        ret.push(...files);
    }
    ret[0][1] = data;
    return ret;
}
module.exports.getDeepFiles = getDeepFiles;