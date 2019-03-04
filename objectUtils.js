function isArray( object )
{
    return Object.prototype.toString.call( object ) === '[object Array]';
}

function append( target, source )
{
    return target.length > 0 ? target + "." + source : source;
}

function getProperties( object, path, results, expandedPath, indexes )
{
    if( results === undefined )
    {
        results = [];
        indexes = "";
        expandedPath = "";
    }

    var o = object;
    var p = path;
    var dot = p.indexOf( "." );
    while( o && dot > -1 )
    {
        var subPath = p.substr( 0, dot );
        expandedPath = append( expandedPath, subPath );
        o = o[ subPath ];
        if( isArray( o ) )
        {
            o.map( function( c, index )
            {
                getProperties( c, p.substr( dot + 1 ), results, expandedPath + "[" + index + "]", ( indexes + " " + index ).trim() );
            } );
        }
        else
        {
            p = p.substr( dot + 1 );
            dot = p.indexOf( "." );
        }
    }

    expandedPath = append( expandedPath, p );
    if( o && o[ p ] )
    {
        results.push( { value: o[ p ], indexes: indexes, path: path, expandedPath: expandedPath } );
    }

    return results;
}

function getUniqueProperty( object, path, indexes )
{
    var indexList = indexes ? indexes.split( " " ) : undefined;
    var o = object;
    var p = path;
    var dot = p.indexOf( "." );
    while( o && dot > -1 )
    {
        o = o[ p.substr( 0, dot ) ];
        if( isArray( o ) )
        {
            o = o[ parseInt( indexList.shift() ) ];
        }
        p = p.substr( dot + 1 );
        dot = p.indexOf( "." );
    }

    return ( o && o[ p ] );
}

module.exports.isArray = isArray;
module.exports.getProperties = getProperties;
module.exports.getUniqueProperty = getUniqueProperty;