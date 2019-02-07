var nodeSsh = require( 'node-ssh' );
var os = require( 'os' );

var ssh = new nodeSsh();

var currentProcess;

function GerritError( error, stderr )
{
    this.message = error;
    this.stderr = stderr;
}

function formatResults( stdout, debug )
{
    if( !stdout )
    {
        return [];
    }

    stdout = stdout.trim();

    var results = [];

    try
    {
        results = stdout
            .split( '\n' )
            .map( ( line ) => new Entry( line ) );
    }
    catch( e )
    {
        debug( e );
    }

    return results;
}

module.exports.run = function run( query, options )
{
    function debug( text )
    {
        if( options && options.outputChannel )
        {
            options.outputChannel.appendLine( text );
        }
    }

    return new Promise( function( resolve, reject )
    {
        ssh.connect( {
            host: query.server,
            username: os.userInfo().username,
            port: query.port,
            privateKey: query.keyFile
        } ).then( function()
        {
            debug( JSON.stringify( query ) );
            ssh.execCommand( [ query.command, query.query, query.options, "--format JSON" ].join( " " ) ).then( function( result )
            {
                resolve( formatResults( result.stdout, debug ) );
                ssh.dispose();
            } )
        }, function( error )
            {
                reject( new GerritError( error, "" ) );
                ssh.dispose();
            }
        );
    } );
};

class Entry
{
    constructor( text )
    {
        this.details = JSON.parse( text );
    }
}

module.exports.Entry = Entry;
