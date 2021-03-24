/* jshint esversion:6 */

var vscode = require( 'vscode' );
var fs = require( 'fs' );
var path = require( 'path' );
var os = require( 'os' );
var childProcess = require( 'child_process' );
var ini = require( 'ini' );
var stripJsonComments = require( 'strip-json-comments' );

var gerrit = require( './gerrit.js' );
var tree = require( "./tree.js" );
var objectUtils = require( "./objectUtils.js" );

var autoRefresh;
var lastResults;
var showTree = false;
var icons = {};
var formatters = {};
var decorations = {};
var structure = [
    {
        "property": "project",
        "icon": "beaker",
        "children": [
            {
                "property": "branch",
                "label": "branch: ${branch}",
                "icon": "git-branch",
                "sort": true,
                "children": [
                    {
                        "property": "status",
                        "sort": true,
                        "children": [
                            {
                                "property": "subject",
                                "sort": true,
                                "icon": "overallScore",
                                "showChanged": true,
                                "label": "${number} ${subject}",
                                "hasContextMenu": true,
                                "tooltip": "${commitMessage}",
                                "children": [
                                    {
                                        "property": "patchSets.number",
                                        "label": "Patch Set ${patchSets.number}",
                                        "sort": true,
                                        "children": [
                                            {
                                                "property": "patchSets.comments.file",
                                                "tooltip": "${patchSets.comments.file}",
                                                "icon": "comment",
                                                "command": "fetch",
                                                "arguments": [
                                                    "${patchSets.comments.file}",
                                                    "${patchSets.revision}",
                                                    "${number}",
                                                    "${patchSets.number}"
                                                ],
                                                "children": [
                                                    {
                                                        "property": "patchSets.comments*.message",
                                                        "label": "line ${patchSets.comments.line}, ${patchSets.comments.reviewer.username}: ${patchSets.comments.message}",
                                                        "tooltip": "${patchSets.comments.message}"
                                                    }
                                                ]
                                            }
                                        ]
                                    },
                                    {
                                        "property": "currentPatchSet.number",
                                        "sort": true,
                                        "label": "Patch set: ${currentPatchSet.number}",
                                        "showChanged": true
                                    },
                                    {
                                        "property": "currentPatchSet.approvals.by.name",
                                        "sort": true,
                                        "icon": "score",
                                        "tooltip": "${currentPatchSet.approvals.by.email}",
                                        "showChanged": true
                                    },
                                    {
                                        "property": "id",
                                        "label": "ID: ${id}"
                                    },
                                    {
                                        "property": "createdOn",
                                        "formatter": "created"
                                    },
                                    {
                                        "property": "lastUpdated",
                                        "sort": true,
                                        "formatter": "updated",
                                        "showChanged": true
                                    },
                                    {
                                        "property": "owner.name",
                                        "label": "Owner: ${owner.name} (${owner.username})",
                                        "children": [
                                            {
                                                "property": "owner.email"
                                            }
                                        ]
                                    },
                                    {
                                        "property": "comments",
                                        "label": "Comments",
                                        "showChanged": true,
                                        "children": [
                                            {
                                                "property": "comments.message",
                                                "tooltip": "${comments.message}"
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        ]
    }
];

function toString( date )
{
    return Intl.DateTimeFormat(
        'en-GB',
        { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    ).format( date );
}

function activate( context )
{
    var outputChannel;

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

    function loadTreeStructure()
    {
        var treeConfigFile = vscode.workspace.getConfiguration( 'gerrit-view' ).get( 'treeConfigFile' );
        if( treeConfigFile !== "" )
        {
            try
            {
                debug( "Reading tree structure from " + treeConfigFile );
                var withComments = fs.readFileSync( treeConfigFile, 'utf-8' );
                var withoutComments = stripJsonComments( withComments );
                structure = JSON.parse( withoutComments );
            }
            catch( e )
            {
                debug( "Failed to load " + treeConfigFile + ":" + e );
                debug( "Using default tree structure" );
            }
        }
    }

    resetOutputChannel();

    var provider = new tree.TreeNodeProvider( context );

    var gerritViewExplorer = vscode.window.createTreeView( "gerrit-view-explorer", { treeDataProvider: provider, showCollapseAll: true } );
    var gerritViewScm = vscode.window.createTreeView( "gerrit-view-scm", { treeDataProvider: provider, showCollapseAll: true } );

    context.subscriptions.push( provider );
    context.subscriptions.push( gerritViewExplorer );
    context.subscriptions.push( gerritViewScm );

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
        context.workspaceState.update( 'filter', {} );
        provider.clearFilter();
        refresh();
    }

    function getGitFolder()
    {
        var folder;

        if( vscode.workspace.workspaceFolders.length === 1 )
        {
            folder = childProcess.execSync( "git rev-parse --show-toplevel", { cwd: vscode.workspace.workspaceFolders[ 0 ].uri.fsPath, encoding: 'utf8' } ).toString().trim();
        }
        else
        {
            var config = vscode.workspace.getConfiguration( 'gerrit-view' );
            folder = config.get( 'localRepo', "" );
        }

        if( !folder )
        {
            vscode.workspace.showInformationMessage( "Please set the location of your local git repository in your settings." );
        }

        return folder;
    }

    function enterServerHostname()
    {
        var config = vscode.workspace.getConfiguration( 'gerrit-view' );
        vscode.window.showInputBox( {
            prompt: "Please enter your gerrit server hostname:",
            value: config.get( 'server' )
        } ).then(
            function( name )
            {
                if( name !== undefined && name.trim().length > 0 )
                {
                    debug( "Server hostname: " + name );
                    showTree = true;
                    config.update( 'server', name, vscode.ConfigurationTarget.Workspace );
                }
                setContext();
            } );
    }

    function getGerritData( refreshRequired )
    {
        function replaceOrAdd( queryArguments, parameter, value )
        {
            if( queryArguments.indexOf( parameter + ':' ) !== -1 )
            {
                var regex = new RegExp( "(" + parameter + ":\\S+)" );
                queryArguments = queryArguments.replace( regex, function( v )
                {
                    return parameter + ':' + value;
                } );
            }
            else
            {
                queryArguments += ' ' + parameter + ':' + value;
            }

            return queryArguments;
        }

        var config = vscode.workspace.getConfiguration( 'gerrit-view' );

        if( vscode.window.state.focused !== true )
        {
            return;
        }

        var disabled = config.get( 'disabled' );
        if( disabled === 'disabled' )
        {
            debug( "Disabled" );
            showTree = false;
            setContext();
            return;
        }
        var server = config.get( 'server' ).trim();
        var port = config.get( 'port' );
        var queryArguments = config.get( "query" );

        var localRepo = getGitFolder();
        var gitReviewFilename = path.join( localRepo, '.gitreview' );
        var gitReview;
        if( fs.existsSync( gitReviewFilename ) )
        {
            debug( "Found .gitreview" );
            gitReview = ini.parse( fs.readFileSync( gitReviewFilename, 'utf-8' ) );

            debug( "Settings: " + JSON.stringify( gitReview.gerrit ) );

            if( gitReview.gerrit )
            {
                if( gitReview.gerrit.host )
                {
                    server = gitReview.gerrit.host;
                }
                if( gitReview.gerrit.port )
                {
                    port = gitReview.gerrit.port;
                }
                if( gitReview.gerrit.defaultbranch )
                {
                    queryArguments = replaceOrAdd( queryArguments, 'branch', gitReview.gerrit.defaultbranch );
                }
                if( gitReview.gerrit.project )
                {
                    queryArguments = replaceOrAdd( queryArguments, 'project', gitReview.gerrit.project );
                }
            }
        }

        if( server !== '' )
        {
            var query = {
                port: port,
                server: server,
                command: "gerrit query",
                query: queryArguments,
                options: config.get( "options" ),
                keyFile: config.get( "pathToSshKey" ) ? path.join( os.homedir(), config.get( "pathToSshKey" ) ) : null,
                agent: config.get( "useSshAgent" ) ? process.env.SSH_AUTH_SOCK : null
            };

            var options =
            {
                outputChannel: outputChannel,
                maxBuffer: config.get( "queryBufferSize" ),
                username: config.get( "username" )
            };

            debug( "query:" + JSON.stringify( query ) );
            debug( "options:" + JSON.stringify( options ) );

            gerrit.run( query, options ).then( function( results )
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
        } else
        {
            showTree = false;
            setContext();
        }
    }

    function buildTree( results )
    {
        if( results !== undefined )
        {
            loadTreeStructure();

            provider.setStructure( structure );

            var changed = provider.populate( results, icons, formatters, "number" );

            debug( results.length + " entries, " + changed.length + " changed " + ( changed.length > 0 ? ( "(" + changed.join( "," ) + ")" ) : "" ) );

            var filter = context.workspaceState.get( 'filter', {} );

            debug( "Filter: " + JSON.stringify( filter ) );
            provider.filter( filter );

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
        var scoreToName = ( score ) =>
        {
            switch( score )
            {
                case -2: return "minus-two";
                case -1: return "minus-one";
                case 1: return "plus-one";
                case 2: return "plus-two";
            }
            return null;
        };

        icons.overallScore = function( entry )
        {
            var name;
            var built = false;
            var failed = false;
            var scoresByType = new Map();

            if( entry.currentPatchSet && entry.currentPatchSet.approvals !== undefined )
            {
                entry.currentPatchSet.approvals.map( function( approval )
                {
                    if( approval.type === "Verified" )
                    {
                        built = true;
                    }

                    if( failed === false )
                    {
                        var approvalScore = parseInt( approval.value );

                        if( approval.type === "Verified" )
                        {
                            if( approvalScore === -1 )
                            {
                                failed = true;
                            }
                        }
                        else
                        {
                            if( scoresByType.has( approval.type ) === false )
                            {
                                scoresByType.set( approval.type, null );
                            }
                            if( approvalScore === -2 || scoresByType.get( approval.type ) === -2 )
                            {
                                scoresByType.set( approval.type, -2 );
                            }
                            else if( approvalScore === -1 && scoresByType.get( approval.type ) < 2 )
                            {
                                scoresByType.set( approval.type, -1 );
                            }
                            else if( approvalScore === 1 && scoresByType.get( approval.type ) < 2 && scoresByType.get( approval.type ) > -1 )
                            {
                                scoresByType.set( approval.type, 1 );
                            }
                            else if( approvalScore === 2 )
                            {
                                scoresByType.set( approval.type, 2 );
                            }
                        }
                    }
                } );
            }

            if( built === false )
            {
                name = "building";
            }
            else if( failed === true )
            {
                name = "failed";
            }
            else if( scoresByType.size < parseInt( vscode.workspace.getConfiguration( 'gerrit-view' ).get( 'approvalNumber' ) ) )
            {
                var minScore = Array.from( scoresByType.values() ).reduce( ( acc, val ) => val < 2 ? Math.min( acc, val ) : acc, null );
                name = scoreToName( minScore ) || "verified";
            }
            else
            {
                var minScore = Array.from( scoresByType.values() ).reduce( ( acc, val ) => Math.min( acc, val ) );
                name = scoreToName( minScore );
            }

            return name;
        };

        icons.score = function( entry, property )
        {
            var value = parseInt( objectUtils.getUniqueProperty( entry, "currentPatchSet.approvals.value", property.indexes ) );
            var name = scoreToName( value );
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

        class GerritViewContentProvider
        {
            setContent( content )
            {
                this._content = content;
            }
            provideTextDocumentContent( uri )
            {
                return this._content;
            }
        };

        var contentProvider = new GerritViewContentProvider();

        context.subscriptions.push( vscode.workspace.registerTextDocumentContentProvider( 'gerrit-view', contentProvider ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'gerrit-view.enterServerHostname', enterServerHostname ) );

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

        context.subscriptions.push( vscode.commands.registerCommand( 'gerrit-view.fetch', ( node ) =>
        {
            var config = vscode.workspace.getConfiguration( 'gerrit-view' );
            var localRepo = config.get( 'localRepo' );
            if( !localRepo )
            {
                localRepo = getGitFolder();
            }

            if( node.arguments && localRepo )
            {
                var file = node.arguments[ 0 ];
                var revision = node.arguments[ 1 ];
                var changeSet = node.arguments[ 2 ];
                var patchSet = node.arguments[ 3 ];

                // https://stackoverflow.com/questions/18515488/how-to-check-if-the-commit-exists-in-a-git-repository-by-its-sha-1
                var foundCommit = false;
                try
                {
                    childProcess.execSync( "git cat-file -t " + revision, { cwd: localRepo } );
                    foundCommit = true;
                }
                catch( e )
                {
                }

                if( foundCommit !== true )
                {
                    debug( "Commit not currently in repo. Fetching..." );
                    try
                    {
                        var command = "git fetch origin refs/changes/" + changeSet.substr( 2 ) + "/" + changeSet + "/" + patchSet;
                        childProcess.execSync( command, { cwd: localRepo } );
                    }
                    catch( e )
                    {
                        console.log( e );
                        vscode.window.showErrorMessage( e.message );
                        return;
                    }
                }

                // https://stackoverflow.com/questions/610208/how-to-retrieve-a-single-file-from-a-specific-revision-in-git
                var command = "git show " + revision + ":" + file;
                var fileContent = childProcess.execSync( command, { cwd: localRepo } ).toString();

                contentProvider.setContent( fileContent );

                var uri = vscode.Uri.parse( 'gerrit-view:' + file );

                vscode.workspace.openTextDocument( uri ).then( function( document )
                {
                    vscode.window.showTextDocument( document ).then( function( editor )
                    {
                        var cs = lastResults.filter( function( c )
                        {
                            return c.details.number === changeSet;
                        } );
                        var ps = cs[ 0 ].details.patchSets.filter( function( p )
                        {
                            return p.number === patchSet;
                        } );
                        var comments = ps[ 0 ].comments.filter( function( c )
                        {
                            return c.file === file;
                        } );

                        var authors = {};
                        var messages = {};

                        comments.map( function( comment )
                        {
                            var line = ( comment.line > 0 ) ? comment.line : 1;
                            if( authors[ line ] === undefined )
                            {
                                authors[ line ] = [ comment.reviewer.name ];
                            }
                            else if( authors[ line ].indexOf( comment.reviewer.name ) === -1 )
                            {
                                authors[ line ].push( comment.reviewer.name );
                            }

                            if( messages[ line ] === undefined )
                            {
                                messages[ line ] = comment.reviewer.name + ": " + comment.message;
                            }
                            else
                            {
                                messages[ line ] += "\n\n" + comment.reviewer.name + ": " + comment.message;
                            }

                        } );

                        if( decorations[ editor.id ] !== undefined )
                        {
                            Object.keys( decorations[ editor.id ] ).map( function( line )
                            {
                                decorations[ editor.id ][ line ].dispose();
                            } );
                        }

                        decorations[ editor.id ] = {};

                        Object.keys( authors ).map( function( line )
                        {
                            var lineNumber = parseInt( line ) - 1;
                            var startPos = new vscode.Position( lineNumber, 0 );
                            var endPos = new vscode.Position( lineNumber, editor.document.lineAt( lineNumber ).range.end.character );
                            var annotationRange = {
                                range: new vscode.Range( startPos, endPos ),
                                hoverMessage: "```text\n" + messages[ line ] + "\n```"
                            };

                            var decoration = decorations[ editor.id ][ line ];
                            if( decoration === undefined )
                            {
                                var marker = {
                                    backgroundColor: config.get( "comments.backgroundColour", "#008000" ),
                                    color: config.get( "comments.colour", "#ffffff" ),
                                    contentText: authors[ line ].join( ", " )
                                };

                                decoration = vscode.window.createTextEditorDecorationType( {
                                    overviewRulerLane: vscode.OverviewRulerLane.Full,
                                    dark: {
                                        overviewRulerColor: config.get( "comments.lineHighlightColour", "#004000" ),
                                        gutterIconPath: context.asAbsolutePath( path.join( "resources/icons", "dark", "comment.svg" ) ),
                                        gutterIconSize: "contain",
                                        backgroundColor: config.get( "comments.lineHighlightColour", "#004000" ),
                                        after: marker
                                    },
                                    light: {
                                        overviewRulerColor: config.get( "comments.lineHighlightColour", "#004000" ),
                                        gutterIconPath: context.asAbsolutePath( path.join( "resources/icons", "light", "comment.svg" ) ),
                                        gutterIconSize: "contain",
                                        backgroundColor: config.get( "comments.lineHighlightColour", "#004000" ),
                                        after: marker
                                    },
                                    isWholeLine: true
                                } );
                                decorations[ editor.id ][ line ] = decoration;
                            }

                            editor.setDecorations( decoration, [ annotationRange ] );
                        } );
                    } );
                } );
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
        context.subscriptions.push( vscode.commands.registerCommand( 'gerrit-view.resetCache', function()
        {
            provider.reset();
            getGerritData();
        } ) );

        context.subscriptions.push( vscode.window.onDidChangeWindowState( function( e )
        {
            if( e.focused )
            {
                var interval = parseInt( vscode.workspace.getConfiguration( 'gerrit-view' ).get( 'autoRefresh' ) );

                if( !isNaN( interval ) && interval > 0 )
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
                        scheduleRefresh();
                    }
                }
            }
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'gerrit-view.openInBrowser', function( item )
        {
            debug( item.source.url );
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

        context.subscriptions.push( gerritViewExplorer.onDidExpandElement( function( e ) { provider.setExpanded( e.element.id, true ); } ) );
        context.subscriptions.push( gerritViewExplorer.onDidCollapseElement( function( e ) { provider.setExpanded( e.element.id, false ); } ) );
        context.subscriptions.push( gerritViewScm.onDidExpandElement( function( e ) { provider.setExpanded( e.element.id, true ); } ) );
        context.subscriptions.push( gerritViewScm.onDidCollapseElement( function( e ) { provider.setExpanded( e.element.id, false ); } ) );

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

        setContext();

        loadTreeStructure();
        getGerritData( false );

        scheduleRefresh();
    }

    debug( "Ready" );

    register();
}

function deactivate()
{
    provider.clear( [] );
}

exports.activate = activate;
exports.deactivate = deactivate;
