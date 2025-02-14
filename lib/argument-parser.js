const path = require('path');

function clean(str) {
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}
module.exports = function parseArgs(keys, argv) {
    const lookup = { '?': 'help', 'help': 'help' };
    for (const [k,v] of Object.entries(keys)) {
        for (const varient of v[0]) {
            lookup[clean(varient)] = k;
        }
        lookup[k] = k;
    }

    if (path.basename(argv[0]) === 'node')
        argv = argv.slice(2);
    else argv = argv.slice(1);

    const args = Object.entries(keys)
        .reduce((cur, [k,v]) => (cur[k] = v[1], cur), {});
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const key = arg[0] === '-'
            ? arg[1] === '-'
                ? lookup[arg.slice(2)]
                : lookup[arg.slice(1)]
            : lookup['default'] ?? 'default';
        if (arg[0] === '-') i++;
        args[key] = argv[i];
    }
    if ('help' in args) {
        let largest;
        const lines = Object.entries(keys)
            .map(([name, mapping]) => [
                `--${name}, ` + (mapping[0]
                    .map(key => 
                        key === 'default' 
                            ? '\x1b[32m\x1b[1mdefault\x1b[0m' 
                            : key.length > 1 
                                ? `--${key}` 
                                : `-${key}`
                    )
                    .join(', ')),
                mapping[2],
                mapping[1] 
                    ? `\x1b[1mDefault: ${mapping[1]}\x1b[0m` 
                    : ''
            ])
            .map((str, i, lines) => {
                largest ??= lines.reduce((c,v) => Math.max(c,clean(v[0]).length), 0);
                const spacing = ' '.repeat(largest - clean(str[0]).length);
                return `${spacing}  ${str[0]} : ${str[1]} ${str[2]}`;
            });

        console.log(lines.map(line => line.split(':')[0].padStart(largest, ' ') + ':' + line.split(':').slice(1).join(':')).join('\n'));
        process.exit(0);
    }
    return args;
}