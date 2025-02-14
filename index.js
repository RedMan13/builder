const runPHP = require('./lib/php-execute');
const PrecompManager = require('./lib/precomp-manager');
const PrecompUtils = require('./lib/precomp-utils');
const Tokenizer = require('./lib/tokenizer');
const MJSHelpers = require('./lib/mjs-helpers');
const CJSHelpers = require('./lib/js-helpers');

module.exports = {
    runPHP,
    PrecompManager,
    PrecompUtils,
    Tokenizer,
    MJSHelpers,
    CJSHelpers
}
