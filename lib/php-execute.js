const path = require('path');
const child = require('child_process');
const phpEnvDefualts = {
    // The name and version of the information server software answering the request (and running the gateway). Format: name/version
    SERVER_SOFTWARE: 'gsa-website-builder/V1.0',
    
    // The server's hostname, DNS alias, or IP address as it would appear in self-referencing URLs.
    SERVER_NAME: 'localhost',
    
    // The revision of the CGI specification to which this server complies. Format: CGI/revision
    GATEWAY_INTERFACE: 'CGI/1.1',
    /* per-request info */
    
    // If the server supports user authentication, and the script is protects, this is the protocol-specific authentication method used to validate the user.
    AUTH_TYPE: '',
    
    // If the server supports user authentication, and the script is protected, this is the username they have authenticated as.
    REMOTE_USER: '',
    
    // If the HTTP server supports RFC 931 identification, then this variable will be set to the remote user name retrieved from the server. Usage of this variable should be limited to logging only.
    REMOTE_IDENT: '',

    // i have no fucking idea what this is
    REDIRECT_STATUS: ''
};

function runPHP(req, file, opt_args = []) {return new Promise(resolve => {
    // we need time to giPATH_TRANSLATED=./joe.const.php php-cgive all the info to php
    req.pause();
    
    const urlInfo = req.originalUrl.slice(req.path.length);
    const hashChar = urlInfo.indexOf('#');
    const queryStringEnd = hashChar === -1 
        ? urlInfo.length + 1 
        : hashChar;
    const hashString = decodeURIComponent(urlInfo.slice(urlInfo.indexOf('#') + 1));
    const queryString = urlInfo.slice(urlInfo.indexOf('?') + 1, queryStringEnd);
    const env = {
        // The name and revision of the information protcol this request came in with. Format: protocol/revision
        SERVER_PROTOCOL: req.protocol, // so uhhhhhh, the fuck is revision? i have never heard of that anywhere in relation to request protocol
        
        // The port number to which the request was sent.
        SERVER_PORT: 3000, // should maby like but this in an env file to be refrenced better
        
        // The method with which the request was made. For HTTP, this is "GET", "HEAD", "POST", etc.
        REQUEST_METHOD: req.method,
        
        // The extra path information, as given by the client. In other words, scripts can be accessed by their virtual pathname, followed by extra information at the end of this path. The extra information is sent as PATH_INFO. This information should be decoded by the server if it comes from a URL before it is passed to the CGI script.
        PATH_INFO: hashString, // idk if this is right or not, but the hash string isnt given anywhere else sooooooooo
        
        // The server provides a translated version of PATH_INFO, which takes the path and does any virtual-to-physical mapping to it.
        PATH_TRANSLATED: file, // give what we have determined the file path as
        
        // A virtual path to the script being executed, used for self-referencing URLs.
        SCRIPT_NAME: req.path, // give what the user told us the file path is
        
        // The information which follows the ? in the URL which referenced this script. This is the query information. It should not be decoded in any fashion. This variable should always be set when there is query information, regardless of command line decoding.
        QUERY_STRING: queryString,
        
        // The hostname making the request. If the server does not have this information, it should set REMOTE_ADDR and leave this unset.
        REMOTE_HOST: req.hostname,
        
        // The IP address of the remote host making the request.
        REMOTE_ADDR: req.hostname, // so uhhhhh, pretty sure express never actually gives us an ip we can pass down to here easily, so ig just like assume php will handle it
        
        // For queries which have attached information, such as HTTP POST and PUT, this is the content type of the data.
        CONTENT_TYPE: req.get('Content-Type'),
        
        // The length of the said content as given by the client.
        CONTENT_LENGTH: req.get('Content-Length'),
            
        ...phpEnvDefualts
    };
    for (const header in req.headers) {
        const transformed = `HTTP_${header.toUpperCase().replaceAll('-', '_')}`;
        const data = req.headers[header];
        env.ALL_HTTP += `${transformed}: ${data}\n`;
        env.ALL_RAW += `${header}: ${data}\n`;
        env[transformed] = data;
    }

    let res = '';
    let err = '';
    const php = child.spawn('php-cgi', opt_args, { env, pwd: path.resolve('.')});
    console.log('running php on file', file, php);
    php.stdin.on('error', function() {
        console.error("Error from server");
    });
    
    req.pipe(php.stdin);
    req.resume();

    php.stdout.on('data', function(data) {
        res += data.toString();
    });
    php.stderr.on('data', function(data) {
        err += data.toString();
    });
    php.on('error', function(err) {
        console.error("error", err);
    });
    php.on('exit', function() {
        // extract headers
        php.stdin.end();

        // where ever the first double new-line is or the start of the data
        const headerEnd = res.indexOf('\r\n\r\n');
        const headerStrings = res.slice(0, headerEnd + 1);
        const htmlString = headerEnd < 0
            ? res 
            : res.slice(headerEnd + 4);
        const headers = [];
        let status = 200;

        for (const [m, name, value] of headerStrings.matchAll(/\r?\n\r?([a-z]+(-[a-z])?): ([^\r\n]+)/gi)) {
            console.log(m);
            if (name === 'Status') {
                status = parseInt(value);
                continue
            }
            headers.push([name, value]);
        }
        

        if (err) {
            console.log('ohnows an php error!!!!!!!!!!!!!!');
            console.error(err);
        }
        resolve({
            headers,
            status,
            html: htmlString || err,
            err
        });
    });
})};
module.exports = runPHP;
