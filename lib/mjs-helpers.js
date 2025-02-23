const fs = require('fs/promises');
const path = require('path');
const { jumpArbit } = require('./js-helpers');

const extensions = [
    '', 
    '/index.js', '/index.mjs', '/index.cjs', '/index.json', 
    '.js', '.mjs', '.cjs', '.json'
];
/** @import { PrecompManager, PrecompUtils } from ../index.js */
/** @function resolveImport */
const resolveImport = module.exports.resolveImport = (() => {
    const cached = {};
    const nodeImports = [];
    const node = path.resolve('node_modules');
    /**
     * resolves the actual import location for a file
     * @param {string} root the dirname that is being imported from
     * @param {string} imp the targeted import
     * @param {PrecompManager|PrecompUtils|null} manager optional, if included this function will resolve to the built file instead of the source file.
     * @returns {Promise<[boolean, string, string]>} 
     *      ret[0]: if this file was found inside node_modules or not. 
     *      ret[1]: the relative path to the file. 
     *      ret[2]: the absolute path to the file.
     */
    async function resolveImport(root, imp, manager) {
        const cacheKey = root + imp + !!manager;
        if (cached[cacheKey]) return cached[cacheKey];
        const res = await (async () => {
            const importName = imp;
            const tried = [];
            let pathTo;
            let data;
            let triedExts = 0;
            let triedNode = false;
            do {
                pathTo = path.resolve(root, imp) + extensions[triedExts];
                data = await fs.stat(pathTo).catch(() => null);
                if (!data || data.isDirectory()) {
                    triedExts++;
                    if (triedExts >= extensions.length) {
                        // cant find this import
                        if (triedNode) break;
                        imp = path.resolve(node, imp);
                        triedNode = true;
                        triedExts = 0;
                    }
                }
                tried.push(pathTo);
            } while (!data || data.isDirectory());
            if (!data) {
                console.warn(`couldnt locate import ${importName} from ${root}. tried ${JSON.stringify(tried, null, 4)}`);
                return [false, importName, path.resolve(root, importName)];
            }
            if (triedNode) nodeImports.push(importName);
            let relative = path.relative(root, pathTo);
            if (manager) {
                const [res] = await manager.getFile(pathTo);
                relative = path.relative(root.replace(manager.entry.slice(0, -1), manager.buildDir), res);
            }
            return [
                triedNode, 
                relative[0] === '.' ? relative : `./${relative}`, 
                pathTo
            ];
        })();
        cached[cacheKey] = res;
        return res;
    }
    /** @returns {string[]} */
    resolveImport.getNodes = () => nodeImports;
    return resolveImport;
})()

const captureRequired = /require\((?<module>.*?)\)/;
const captureModule = /(?:module\s*\.\s*)?exports/;
const captureImport = /(import\s+(?:.+?\s*from\s*)?)(?<module>["'].*?["'])(;?)/;
const captureExport = /export\s+(?:default\s*)?/;
/**
 * converts a CJS file into MJS
 * @param {string} module The path to module
 * @param {string} file CJS File contents
 * @returns {string} The new MJS file contents
 */
module.exports.toMJS = async function(module, file, manager) {
    let imprtVar = 0;
    let exprtVar = 0;
    let out = `
        const exports = {};
        const module = { exports };
    `;
    const root = path.dirname(module);
    file.match(captureRequired);
    const cjsImport = [];
    for (let i = 0; i < file.length; i++) {
        const jmp = jumpArbit(file.slice(i));
        if (jmp) {
            out += file.slice(i, jmp +i);
            i += jmp -1;
            continue;
        }
        const m = captureRequired.exec(file.slice(i));
        if (m && m.index === 0) {
            const [isNode, imp, pathTo] = await resolveImport(root, m[1], manager);
            cjsImport.push(pathTo);
            const importVar = `$_IMPORT_$_VARIABLE_$_${++imprtVar}_$`;
            const defaultVar = `$_IMPORT_DEFAULT_$_VARIABLE_$_${imprtVar}_$`;
            i += m[0].length -1;
            out = `
                import * as ${importVar} from "${imp}";
                const ${defaultVar} = ${importVar}.default;
                ${out}(${defaultVar} ?? ${importVar})
            `;
            continue;
        }
        out += file[i];
    }
    const cjsExport = require(module);
    const hasDefault = typeof cjsExport !== 'object' || // anything other then an object export
        !!cjsExport[Symbol.hasInstance] || // class export
        Object.keys(cjsExport).length === 0; // googles infinite wisdom module that only exports an object for the purpose of then being reimported and modfied externally
    const safeExporters = {};
    Object.keys(cjsExport).map(key => safeExporters[key] = [`$_EXPORT_$_VARIABLE_$_${exprtVar++}_$`]);

    return [cjsImport, `
        ${out}
        ${hasDefault 
            ? 'export default module.exports' 
            : `
                const { ${Object.entries(safeExporters)
                            .map(([key, safe]) => `"${key}": ${safe}`)
                            .join(', ')} } = module.exports;
                export { ${Object.entries(safeExporters)
                            .map(([key, safe]) => `${safe} as "${key}"`)
                            .join(', ')} }
            `}
    `];
}
module.exports.isMJS = function(file) {
    return captureImport.test(file) || captureExport.test(file) ||
        !(captureRequired.test(file) || captureModule.test(file));
}
module.exports.captures = {
    requires: captureRequired,
    cjsExports: captureModule,
    imported: captureImport,
    exported: captureExport
}
