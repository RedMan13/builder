const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const { jumpArbit } = require('./js-helpers');

const coreModules = ['assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'crypto', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'quic', 'readline', 'repl', 'sqlite', 'stream', 'string_decoder', 'test', 'tls', 'trace_events', 'tty', 'dgram', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'];
const extensions = [
    '', 
    '.js', '.mjs', '.cjs', '.json',
    '/index.js', '/index.mjs', '/index.cjs', '/index.json',
];
const stages = [
    // default
    (root, imp) => path.resolve(root, imp),
    // built directory
    (root, imp, manager) => {
        if (!manager) return;
        root = root.replace(manager.entry.slice(0, -1), manager.buildDir);
        return path.resolve(root, imp);
    },
    // node
    (root, imp) => path.resolve('node_modules', imp),
    // node modules main entry
    async (root, imp) => {
        const metaFile = path.resolve('node_modules', path
            .resolve('node_modules', imp)
            .replace(path.resolve('node_modules'), '')
            .split('/')
            .filter(Boolean)[0] 
            + '/package.json');
        if (!fss.existsSync(metaFile)) return;
        const package = JSON.parse(await fs.readFile(metaFile, 'utf8'));
        if (!package.main) return;
        return path.resolve(metaFile, '..', package.main);
    },
];
/** @import { PrecompManager, PrecompUtils } from ../index.js */
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
    const m = imp.match(/^(?:node:)?(?<module>[^\.\/]*)(?<path>.*)$/);
    if (m?.groups?.module && coreModules.includes(m.groups.module))
        return [true, `node:${m.groups.module}${m.groups.path}`, `node:${m.groups.module}${m.groups.path}`];
    const importName = imp;
    const tried = [];
    let pathTo;
    let data;
    let triedExts = 0;
    let triedModes = 0;
    do {
        if (triedModes >= stages.length) break;
        const path = await stages[triedModes](root, imp, manager);
        if (!path) {
            triedModes++;
            triedExts = 0;
            continue;
        }
        pathTo = path + extensions[triedExts];
        data = await fs.stat(pathTo).catch(() => null);
        if (!data || data.isDirectory()) {
            triedExts++;
            if (triedExts >= extensions.length) {
                triedModes++;
                triedExts = 0;
            }
        }
        tried.push(pathTo);
    } while (!data || data.isDirectory());
    if (!data) {
        console.warn(`couldnt locate import ${importName} from ${root}. tried ${JSON.stringify(tried, null, 4)}`);
        return [false, importName, path.resolve(root, importName)];
    }
    let relative = path.relative(root, pathTo);
    if (manager) {
        const [res] = await manager.getFile(pathTo);
        relative = path.relative(root.replace(manager.entry.slice(0, -1), manager.buildDir), res);
    }
    return [
        false, 
        relative[0] === '.' ? relative : `./${relative}`, 
        pathTo
    ];
}
module.exports.resolveImport = resolveImport;

const captureRequired = /require\((?<module>.*?)\)/;
const captureModule = /(?:module\s*\.\s*)?exports/;
const captureImport = /((?<!@)import\s+(?:.+?\s*from\s*)?)(?<module>["'].*?["'])(;?)/;
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
    const hasImport = captureImport.test(file);
    const hasExport = captureExport.test(file);
    return hasImport || hasExport;
}
module.exports.captures = {
    requires: captureRequired,
    cjsExports: captureModule,
    imported: captureImport,
    exported: captureExport
}
