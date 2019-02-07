/* jshint esversion:6 */

var vscode = require( 'vscode' );
var path = require( 'path' );
var fs = require( 'fs' );
var octicons = require( 'octicons' );
var objectUtils = require( './objectUtils.js' );

var storageLocation;

var nodes = [];
var expandedNodes = {};
var changedNodes = {};
var hashes = {};
var keys = new Set();
var selectedNode;
var showChangedOnly = false;

function hash( text )
{
    var hash = 0;
    if( text.length === 0 )
    {
        return hash;
    }
    for( var i = 0; i < text.length; i++ )
    {
        var char = text.charCodeAt( i );
        hash = ( ( hash << 5 ) - hash ) + char;
        hash = hash & hash; // Convert to 32bit integer
    }

    hash = Math.abs( hash ) % 1000000;

    return hash;
}

var hasChangedParent = function( node )
{
    var parent = node.parent;
    while( parent )
    {
        if( parent.showChanged && parent.changed === true )
        {
            return true;
        }
        parent = parent.parent;
    }
    return false;
}

var hasChangedChildren = function( node )
{
    var result = ( node.showChanged === true && node.changed === true );
    if( node.nodes.length > 0 && result === false )
    {
        node.nodes.map( function( child )
        {
            result = result || hasChangedChildren( child );
        } );
    }
    return result;
}

var isVisible = function( node )
{
    var result = node.visible && ( showChangedOnly === false || node.changed === true || hasChangedParent( node ) || hasChangedChildren( node ) );
    if( selectedNode === node.id )
    {
        result = true;
    }
    return result;
};

function forEachNode( callback, children )
{
    if( children === undefined )
    {
        children = nodes;
    }
    if( children !== undefined )
    {
        children.forEach( child =>
        {
            if( child.nodes !== undefined )
            {
                forEachNode( callback, child.nodes );
            }
            callback( child );
        } );
    }
}

function sortNodes( a, b )
{
    return a.label < b.label ? 1 : b.label < a.label ? -1 : a > b ? 1 : -1;
}

function sanitizePath( path )
{
    return path.replace( /\./g, '_' );
}

class TreeNodeProvider
{
    constructor( _context, _structure )
    {
        this._context = _context;
        this._structure = _structure;

        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;

        showChangedOnly = _context.workspaceState.get( 'showChangedOnly', false );
        expandedNodes = _context.workspaceState.get( 'expandedNodes', {} );

        changedNodes = _context.globalState.get( 'changedNodes', {} );
        hashes = _context.globalState.get( 'hashes', {} );

        if( _context.storagePath && !fs.existsSync( _context.storagePath ) )
        {
            fs.mkdirSync( _context.storagePath );
        }
        if( fs.existsSync( _context.storagePath ) )
        {
            storageLocation = _context.storagePath;
        }
        else
        {
            storageLocation = _context.extensionPath;
        }
    }

    getChildren( node )
    {
        if( node === undefined )
        {
            var availableNodes = nodes.filter( function( node )
            {
                return node.nodes === undefined || node.nodes.length > 0;
            } );
            var visibleNodes = availableNodes.filter( isVisible );
            if( visibleNodes.length > 0 )
            {
                return visibleNodes;
            }
            return [ { label: "Nothing found", empty: availableNodes.length === 0 } ];
        }
        else if( node.nodes && node.nodes.length > 0 )
        {
            return node.nodes.filter( isVisible );
        }
        return undefined;
    }

    getParent( node )
    {
        return node.parent;
    }

    getTreeItem( node )
    {
        var treeItem = new vscode.TreeItem( node.label );

        treeItem.id = node.id;

        if( node.showChanged === true && node.changed == true )
        {
            treeItem.label = treeItem.label;
        }
        else
        {
            treeItem.description = treeItem.label;
            treeItem.label = "";
        }

        if( node.nodes && node.nodes.length > 0 )
        {
            treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            if( expandedNodes[ node.id ] !== undefined )
            {
                treeItem.collapsibleState = ( expandedNodes[ node.id ] === true ) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
            }
        }

        if( node.octicon !== undefined )
        {
            treeItem.iconPath = {
                dark: node.octicon,
                light: node.octicon
            };
        }
        else if( node.icon !== undefined )
        {
            var darkIconPath = this._context.asAbsolutePath( path.join( "resources/icons", "dark", node.icon + ".svg" ) );
            var lightIconPath = this._context.asAbsolutePath( path.join( "resources/icons", "light", node.icon + ".svg" ) );

            treeItem.iconPath = {
                dark: darkIconPath,
                light: lightIconPath
            };
        }

        if( node.hasContextMenu === true )
        {
            treeItem.contextValue = "showMenu";
        }

        if( node.tooltip )
        {
            treeItem.tooltip = node.tooltip;
        }

        treeItem.command = {
            command: "gerrit-view.select",
            title: "",
            arguments: [ node ]
        };

        return treeItem;
    }

    clear()
    {
        nodes = [];
    }

    refresh()
    {
        this._onDidChangeTreeData.fire();
    }

    filter( term, children )
    {
        if( term.key !== undefined )
        {
            var matcher = new RegExp( term.text, vscode.workspace.getConfiguration( 'gerrit-view' ).get( 'showFilterCaseSensitive' ) ? "" : "i" );

            if( children === undefined )
            {
                forEachNode( function( node ) { node.visible = false; }, nodes );
                children = nodes;
            }
            children.forEach( child =>
            {
                if( child.nodes.length > 0 )
                {
                    this.filter( term, child.nodes );
                }

                if( child.type.toLowerCase() === term.key.toLowerCase() )
                {
                    if( matcher.test( child.value ) )
                    {
                        child.visible = true;
                        forEachNode( function( node ) { node.visible = true; }, child.nodes );
                        var parent = child.parent;
                        while( parent )
                        {
                            parent.visible = true;
                            parent = parent.parent;
                        }
                    }
                }
            } );
        }
    }

    clearFilter()
    {
        forEachNode( function( e ) { e.visible = true; }, nodes );
    }

    populate( data, icons, formatters, keyField )
    {
        var locateNode = function( node )
        {
            return node.type === this.type && node.value === this.value;
        };

        forEachNode( function( node ) { node.delete = true; }, nodes );

        var updatedEntries = [];

        data.map( function( item, index )
        {
            var entry = item.details;
            var parent;
            var parents = nodes;
            var hasChanged = false;

            var key;

            if( keyField !== undefined )
            {
                key = objectUtils.getUniqueProperty( entry, keyField );

                if( key !== undefined )
                {
                    var newHash = hash( JSON.stringify( entry ) );
                    if( hashes[ key ] != newHash )
                    {
                        updatedEntries.push( key );
                        hasChanged = true;
                    }
                    hashes[ key ] = newHash;
                }
            }

            for( var level = 0; level < this._structure.length; ++level )
            {
                var children = this._structure[ level ].children;
                children.map( function( child )
                {
                    keys.add( child.property );

                    var values = objectUtils.getProperties( entry, child.property );

                    values.map( function( v )
                    {
                        var node;

                        if( level > 0 )
                        {
                            parent = parents.find( locateNode, {
                                type: this._structure[ level ].parent,
                                value: objectUtils.getUniqueProperty( entry, this._structure[ level ].parent )
                            } );
                        }

                        if( parent !== undefined )
                        {
                            node = parent.nodes.find( locateNode, { type: child.property, value: v.value } );
                        }
                        else
                        {
                            node = nodes.find( locateNode, { type: child.property, value: v.value } );
                        }

                        if( node === undefined )
                        {
                            var id = sanitizePath( child.property + ":" + ( parent ? ( parent.id + "." + v.value ) : v.value ) );

                            node = {
                                source: entry,
                                entry: key,
                                level: level,
                                value: v.value,
                                label: v.value,
                                type: child.property,
                                id: id,
                                visible: true,
                                showChanged: child.showChanged,
                                hasContextMenu: child.hasContextMenu,
                                nodes: [],
                                changed: ( changedNodes[ id ] === true || hasChanged )
                            };

                            if( level === 0 )
                            {
                                nodes.push( node );
                                nodes.sort( sortNodes );
                            }
                            else
                            {
                                node.parent = parent;
                                parent.nodes.push( node );
                                parent.nodes.sort( sortNodes );
                            }
                        }
                        else
                        {
                            node.changed = changedNodes[ node.id ] || hasChanged;
                            node.delete = false;
                        }

                        if( child.formatter !== undefined )
                        {
                            if( formatters[ child.formatter ] !== undefined )
                            {
                                node.label = formatters[ child.formatter ]( entry, v );
                            }
                        }

                        if( child.format !== undefined )
                        {
                            var label = child.format;
                            var regex = new RegExp( "\\$\\{(.*?)\\}", "g" );
                            label = label.replace( regex, function( match, name )
                            {
                                return objectUtils.getUniqueProperty( entry, name, v.indexes );
                            } );
                            node.label = label;
                        }

                        if( child.icon )
                        {
                            if( octicons[ child.icon ] )
                            {
                                var colour = new vscode.ThemeColor( "foreground" );
                                var octiconIconPath = path.join( storageLocation, child.icon + ".svg" );

                                if( !fs.existsSync( octiconIconPath ) )
                                {
                                    var octiconIconDefinition = "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\n" +
                                        octicons[ child.icon ].toSVG( { "xmlns": "http://www.w3.org/2000/svg", "fill": "#C5C5C5" } );

                                    fs.writeFileSync( octiconIconPath, octiconIconDefinition );
                                }

                                node.octicon = octiconIconPath;
                            }

                            else if( icons[ child.icon ] !== undefined )
                            {
                                node.icon = icons[ child.icon ]( entry, v );
                            }
                        }

                        if( child.tooltip )
                        {
                            var tooltip = child.tooltip;
                            var regex = new RegExp( "\\$\\{(.*?)\\}", "g" );
                            tooltip = tooltip.replace( regex, function( match, name )
                            {
                                return objectUtils.getUniqueProperty( entry, name, v.indexes );
                            } );
                            node.tooltip = tooltip;
                        }

                        if( hasChanged )
                        {
                            changedNodes[ node.id ] = true;
                            this._context.globalState.update( 'changedNodes', changedNodes );
                        }

                    }, this );
                }, this );
                if( level > 0 && parent !== undefined )
                {
                    parents = parent.nodes;
                }
            }
        }, this );

        this.prune();

        this._context.globalState.update( 'hashes', hashes );

        return updatedEntries;
    }

    prune( children )
    {
        function removeDeletedNodes( children, me )
        {
            return children.filter( function( child )
            {
                if( child.nodes !== undefined )
                {
                    child.nodes = me.prune( child.nodes );
                }
                var shouldRemove = child.delete === true;
                if( shouldRemove === true )
                {
                    delete expandedNodes[ child.id ];
                }
                return shouldRemove === false;
            }, me );
        }

        var root;

        if( children === undefined )
        {
            root = true;
            children = nodes;
        }

        children = removeDeletedNodes( children, this );

        if( root === true )
        {
            nodes = children;
        }

        return children;
    }

    setExpanded( id, expanded )
    {
        var nodeId = id.replace( /\./g, '_' );
        expandedNodes[ nodeId ] = expanded;
        this._context.workspaceState.update( 'expandedNodes', expandedNodes );
    }

    clearExpansionState()
    {
        expandedNodes = {};
        this._context.workspaceState.update( 'expandedNodes', expandedNodes );
    }

    showChangedOnly()
    {
        showChangedOnly = true;
        this.refresh();
    }

    showAll()
    {
        showChangedOnly = false;
        this.refresh();
    }

    setChanged( node, changed )
    {
        if( node.showChanged )
        {
            node.changed = changed;
        }
        if( changed )
        {
            changedNodes[ node.id ] = true;
            forEachNode( function( node ) { if( node.showChanged === true ) { node.changed = true; } }, node.nodes );
            var parent = node.parent;
            while( parent )
            {
                if( parent.showChanged === true )
                {
                    parent.changed = true;
                }
                parent = parent.parent;
            }
        }
        else
        {
            delete changedNodes[ node.id ];
        }
        this._context.globalState.update( 'changedNodes', changedNodes );
        this._context.globalState.update( 'hashes', hashes );
        this.refresh();
    }

    clearAll()
    {
        forEachNode( function( node ) { node.changed = false; }, nodes );
        changedNodes = {};
        this._context.globalState.update( 'changedNodes', changedNodes );
        this.refresh();
    }

    hasChanged()
    {
        var hasChanged = false;
        forEachNode( function( node )
        {
            if( node.showChanged && node.changed && node.visible )
            {
                hasChanged = true;
            }
        }, nodes );
        return hasChanged;
    }

    getKeys()
    {
        return keys;
    }

    setSelected( node )
    {
        selectedNode = node.id;
    }

    sync()
    {
        changedNodes = this._context.globalState.get( 'changedNodes', {} );
        hashes = this._context.globalState.get( 'hashes', {} );
    }
}

exports.TreeNodeProvider = TreeNodeProvider;
