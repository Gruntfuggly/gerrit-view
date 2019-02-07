/* jshint esversion:6 */

var vscode = require( 'vscode' );
var path = require( 'path' );
var os = require( 'os' );
var gerrit = require( './gerrit.js' );
var tree = require( "./tree.js" );
var objectUtils = require( "./objectUtils.js" );

var autoRefresh;
var lastResults;
var showTree = false;
var icons = {};
var formatters = {};

function toString( date )
{
    return Intl.DateTimeFormat(
        'en-GB',
        { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    ).format( date );
}

function activate( context )
{
    var structure = [
        {
            children: [
                { property: "project", icon: "briefcase" }
            ]
        },
        {
            parent: "project",
            children: [
                { property: "branch", format: "branch: ${branch}", icon: "git-branch" }
            ]
        },
        {
            parent: "branch",
            children: [
                { property: "status" }
            ]
        },
        {
            parent: "status",
            children: [
                {
                    property: "subject",
                    icon: "overallScore",
                    showChanged: true,
                    format: "${number} ${subject}",
                    hasContextMenu: true,
                    tooltip: "${commitMessage}"
                }
            ]
        },
        {
            parent: "subject",
            children: [
                { property: "currentPatchSet.approvals.by.name", icon: "score", tooltip: "${currentPatchSet.approvals.by.email}", showChanged: true },
                { property: "id", format: "ID: ${id}" },
                { property: "createdOn", formatter: "created" },
                { property: "lastUpdated", formatter: "updated", showChanged: true },
                { property: "owner.name", format: "Owner: ${owner.name} (${owner.username})" }
            ],
        },
        {
            parent: "owner.name",
            children: [
                { property: "owner.email" }
            ],
        }
    ];

    var provider = new tree.TreeNodeProvider( context, structure );

    var gerritView = vscode.window.createTreeView( "gerrit-view", { treeDataProvider: provider, showCollapseAll: true } );

    var outputChannel;

    context.subscriptions.push( provider );
    context.subscriptions.push( gerritView );

    function resetOutputChannel()
    {
        if( outputChannel )
        {
            outputChannel.dispose();
            outputChannel = undefined;
        }
        if( vscode.workspace.getConfiguration( 'gerrit-view' ).debug === true )
        {
            outputChannel = vscode.window.createOutputChannel( "Gerrit View" );
        }
    }

    function debug( text )
    {
        if( outputChannel )
        {
            outputChannel.appendLine( text );
        }
    }

    function setContext()
    {
        vscode.commands.executeCommand( 'setContext', 'gerrit-view-filtered', context.workspaceState.get( 'filtered', false ) );
        vscode.commands.executeCommand( 'setContext', 'gerrit-view-show-changed-only', context.workspaceState.get( 'showChangedOnly', false ) );
        vscode.commands.executeCommand( 'setContext', 'gerrit-view-has-changed', provider.hasChanged() );
        vscode.commands.executeCommand( 'setContext', 'gerrit-view-show-tree', showTree );
    }

    function refresh()
    {
        provider.refresh();
        setContext();
    }

    function clearFilter()
    {
        currentFilter = undefined;
        context.workspaceState.update( 'filtered', false );
        provider.clearFilter();
        refresh();
    }

    function getGerritData( refreshRequired )
    {
        if( vscode.window.state.focused !== true )
        {
            return;
        }

        var config = vscode.workspace.getConfiguration( 'gerrit-view' );

        if( config.get( 'server' ).trim().length === 0 )
        {
            showTree = true;
            setContext();
            vscode.window.showInputBox( { prompt: "Please enter your gerrit server name:" } ).then(
                function( name )
                {
                    if( name && name.trim().length > 0 )
                    {
                        config.update( 'server', name, true );
                    }
                } );
        }
        else
        {
            var query = {
                port: config.get( "port" ),
                server: config.get( "server" ),
                command: "gerrit query",
                query: config.get( "query" ),
                options: config.get( "options" ),
                keyFile: path.join( os.homedir(), config.get( "pathToSshKey" ) )
            };

            gerrit.run( query, { outputChannel: outputChannel, maxBuffer: config.get( "queryBufferSize" ) } ).then( function( results )
            {
                if( results.length > 0 )
                {
                    buildTree( results );
                }
                else
                {
                    vscode.window.showInformationMessage( "gerrit-view: No results found" );
                }

                scheduleRefresh();

            } ).catch( function( e )
            {
                var message = e.message;
                if( e.stderr )
                {
                    message += " (" + e.stderr + ")";
                }
                vscode.window.showErrorMessage( "gerrit-view: " + message );
            } );

            debug( "Last update: " + new Date().toISOString() );
        }
    }

    function buildTree( results )
    {
        if( results !== undefined )
        {
            var changed = provider.populate( results, icons, formatters, "number" );

            debug( results.length + " entries, " + changed.length + " changed " + ( changed.length > 0 ? ( "(" + changed.join( "," ) + ")" ) : "" ) );

            provider.filter( context.workspaceState.get( 'filter', {} ) );

            if( changed.length > 0 )
            {
                vscode.window.showInformationMessage( "gerrit-view: Updated change sets: " + changed.join( "," ) );
            }

            showTree = true;

            refresh();

            lastResults = results;
        }
    }

    function scheduleRefresh()
    {
        var interval = parseInt( vscode.workspace.getConfiguration( 'gerrit-view' ).get( 'autoRefresh' ) );

        clearInterval( autoRefresh );

        if( !isNaN( interval ) && interval > 0 )
        {
            autoRefresh = setTimeout( getGerritData, interval * 1000 );
        }
    }

    function showChangedOnly()
    {
        context.workspaceState.update( 'showChangedOnly', true );
        provider.showChangedOnly();
        setContext();
    }

    function showAll()
    {
        context.workspaceState.update( 'showChangedOnly', false );
        provider.showAll();
        setContext();
    }

    function clearAll()
    {
        provider.clearAll();
        setContext();
    }

    function register()
    {
        icons.overallScore = function( entry )
        {
            var name;
            var built = false;
            var finished = false;
            var score = 0;

            if( entry.currentPatchSet && entry.currentPatchSet.approvals !== undefined )
            {
                entry.currentPatchSet.approvals.map( function( approval )
                {
                    if( approval.type === "Verified" )
                    {
                        built = true;
                    }

                    if( finished === false )
                    {
                        var approvalScore = parseInt( approval.value );

                        if( approval.type === "Verified" )
                        {
                            if( approvalScore === -1 )
                            {
                                name = "failed";
                                finished = true;
                            }
                            else if( approvalScore === 1 )
                            {
                                name = "verified";
                            }
                        }
                        if( approval.type === "Code-Review" )
                        {
                            if( approvalScore === -2 )
                            {
                                name = "minus-two";
                                finished = true;
                            }
                            else if( approvalScore === -1 && score < 2 )
                            {
                                score = approvalScore;
                            }
                            else if( approvalScore > 0 )
                            {
                                score = approvalScore;
                            }
                        }
                    }
                } );
            }

            if( built === false )
            {
                name = "building";
            }
            else
            {
                switch( score )
                {
                    case 2: name = "plus-two"; break;
                    case 1: name = "plus-one"; break;
                    case -1: name = "minus-one"; break;
                }
            }

            return name;
        };

        icons.score = function( entry, property )
        {
            var value = parseInt( objectUtils.getUniqueProperty( entry, "currentPatchSet.approvals.value", property.indexes ) );
            var name;

            switch( value )
            {
                case -2: name = "minus-two"; break;
                case -1: name = "minus-one"; break;
                case 1: name = "plus-one"; break;
                case 2: name = "plus-two"; break;
            }

            return name;
        };

        formatters.created = function( entry )
        {
            var date = new Date( 0 );
            date.setUTCSeconds( parseInt( entry.createdOn ) );
            return "Created: " + toString( date );
        };
        formatters.updated = function( entry )
        {
            var date = new Date( 0 );
            date.setUTCSeconds( parseInt( entry.lastUpdated ) );
            return "Updated: " + toString( date );
        };

        context.subscriptions.push( vscode.commands.registerCommand( 'gerrit-view.filter', function()
        {
            var keys = Array.from( provider.getKeys() );
            vscode.window.showQuickPick( keys, { matchOnDetail: true, matchOnDescription: true, canPickMany: false, placeHolder: "Select key to filter on" } ).then( function( key )
            {
                vscode.window.showInputBox( { prompt: "Enter value to filer '" + key + "' on:" } ).then(
                    function( term )
                    {
                        currentFilter = term;
                        if( currentFilter )
                        {
                            context.workspaceState.update( 'filtered', true );
                            context.workspaceState.update( 'filter', { key: key, text: currentFilter } );
                            provider.filter( { key: key, text: currentFilter } );
                            refresh();
                        }
                    } );
            } );
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'gerrit-view.select', ( node ) =>
        {
            provider.setSelected( node );
            if( node.showChanged )
            {
                provider.setChanged( node, false );
                setContext();
            }
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'gerrit-view.markAsChanged', ( node ) =>
        {
            if( node.showChanged )
            {
                provider.setChanged( node, true );
                setContext();
            }
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'gerrit-view.filterClear', clearFilter ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'gerrit-view.refresh', getGerritData ) );

        context.subscriptions.push( vscode.window.onDidChangeWindowState( function( e )
        {
            if( e.focused )
            {
                provider.sync();
                if( lastResults === undefined )
                {
                    getGerritData();
                }
                else
                {
                    debug( "Refreshing tree..." );
                    buildTree( lastResults );
                }
            }
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'gerrit-view.openInBrowser', function( item )
        {
            console.log( item.entry.url );
            vscode.commands.executeCommand( 'vscode.open', vscode.Uri.parse( item.source.url ) );
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'gerrit-view.showChangedOnly', showChangedOnly ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'gerrit-view.showAll', showAll ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'gerrit-view.clearAll', clearAll ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'gerrit-view.setQuery', function()
        {
            var currentQuery = vscode.workspace.getConfiguration( 'gerrit-view' ).get( 'query' );
            vscode.window.showInputBox( { prompt: "Gerrit Query", placeholder: "e.g. status:open", value: currentQuery } ).then( function( query )
            {
                if( query )
                {
                    vscode.workspace.getConfiguration( 'gerrit-view' ).update( 'query', query, false ).then( refresh );
                }
            } );
        } ) );

        context.subscriptions.push( gerritView.onDidExpandElement( function( e ) { provider.setExpanded( e.element.id, true ); } ) );
        context.subscriptions.push( gerritView.onDidCollapseElement( function( e ) { provider.setExpanded( e.element.id, false ); } ) );

        context.subscriptions.push( vscode.workspace.onDidChangeConfiguration( function( e )
        {
            if( e.affectsConfiguration( "gerrit-view" ) )
            {
                if( e.affectsConfiguration( "gerrit-view.debug" ) )
                {
                    resetOutputChannel();
                }
                else if( e.affectsConfiguration( "gerrit-view.autoRefresh" ) )
                {
                    scheduleRefresh();
                }
                else
                {
                    getGerritData();
                }

                vscode.commands.executeCommand( 'setContext', 'gerrit-view-in-explorer', vscode.workspace.getConfiguration( 'gerrit-view' ).showInExplorer );
                setContext();
            }
        } ) );

        context.subscriptions.push( outputChannel );

        vscode.commands.executeCommand( 'setContext', 'gerrit-view-in-explorer', vscode.workspace.getConfiguration( 'gerrit-view' ).showInExplorer );

        resetOutputChannel();

        setContext();

        getGerritData( false );

        scheduleRefresh();
    }

    register();
}

function deactivate()
{
    provider.clear( [] );
}

exports.activate = activate;
exports.deactivate = deactivate;
