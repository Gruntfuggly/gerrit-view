var nodeSsh = require( 'node-ssh' );
var os = require( 'os' );
var fs = require( 'fs' );

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
        results.push( new Entry( stdout ) );
        // results = stdout
        //     .split( '\n' )
        //     .map( ( line ) => new Entry( line ) );
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
        fs.readFile( "/Users/nige/last-results.json", "utf8", function( err, data )
        {
            if( err )
            {
                debug( err );
            }
            resolve( formatResults( data, debug ) );
        } );

        // ssh.connect( {
        //     host: query.server,
        //     username: options.username ? options.username : os.userInfo().username.toLowerCase(),
        //     port: query.port,
        //     privateKey: query.keyFile,
        //     agent: query.agent
        // } ).then( function()
        // {
        //     debug( JSON.stringify( query ) );
        //     ssh.execCommand( [ query.command, query.query, query.options, "--format JSON" ].join( " " ) ).then( function( result )
        //     {
        //         fs.writeFileSync( "last-results.json", result.stdout );
        //         resolve( formatResults( result.stdout, debug ) );
        //         ssh.dispose();
        //     } )
        // }, function( error )
        //     {
        //         reject( new GerritError( error, "" ) );
        //         ssh.dispose();
        //     }
        // );
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
