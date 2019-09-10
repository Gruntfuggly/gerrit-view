function isArray( object )
{
    return Object.prototype.toString.call( object ) === '[object Array]';
}

function append( target, source )
{
    return target.length > 0 ? target + "." + source : source;
}

function getProperties( object, path, parentIndexes, results, expandedPath, indexes )
{
    if( results === undefined )
    {
        results = [];
        indexes = [ -1 ];
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
            var parentIndex = parentIndexes.length > 0 ? parentIndexes[ 0 ] : -1;
            o.map( function( c, index )
            {
                if( parentIndex === -1 || index === parentIndex )
                {
                    var indexesCopy = indexes.slice();
                    indexesCopy.push( index );
                    getProperties( c, p.substr( dot + 1 ), parentIndexes.slice( 1 ), results, expandedPath + "[" + index + "]", indexesCopy );
                }
            } );
        }
        else
        {
            indexes.push( -1 );
            p = p.substr( dot + 1 );
            dot = p.indexOf( "." );
        }
    }

    expandedPath = append( expandedPath, p );
    if( o && o[ p ] )
    {
        results.push( { value: o[ p ], indexes: indexes, path: path, expandedPath: expandedPath, parent: o } );
    }

    return results;
}

function getUniqueProperty( object, path, indexes )
{
    var indexList = indexes ? indexes.filter( function( i )
    {
        return i != -1;
    } ) : undefined;
    var o = object;
    var p = path;
    var dot = p.indexOf( "." );
    while( o && dot > -1 )
    {
        o = o[ p.substr( 0, dot ) ];
        if( isArray( o ) )
        {
            o = o[ indexList.shift() ];
        }
        p = p.substr( dot + 1 );
        dot = p.indexOf( "." );
    }

    return ( o && o[ p ] );
}

module.exports.isArray = isArray;
module.exports.getProperties = getProperties;
module.exports.getUniqueProperty = getUniqueProperty;