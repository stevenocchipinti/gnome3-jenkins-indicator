/**
 * @author Philipp Hoffmann
 */

const Lang = imports.lang;
const St = imports.gi.St;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Gio = imports.gi.Gio;
const Shell = imports.gi.Shell;
const Soup = imports.gi.Soup;
const Glib = imports.gi.GLib;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const MessageTray = imports.ui.messageTray;

// this is the messagetray of the current session
const SessionMessageTray = imports.ui.main.messageTray;

// import convenience module (for localization)
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;
const Settings = Me.imports.settings;

// set text domain for localized strings
const _ = imports.gettext.domain(Me.metadata['gettext-domain']).gettext;

// few static settings
const ICON_SIZE_INDICATOR = 16;
const ICON_SIZE_NOTIFICATION = 24;

let _indicators = [];
let settings, settingsJSON;

// signals container (for clean disconnecting from signals if extension gets disabled)
let event_signals = [];

const _httpSession = new Soup.SessionAsync();
Soup.Session.prototype.add_feature.call(_httpSession, new Soup.ProxyResolverDefault());

// append a uri to a domain regardless whether domains ends with '/' or not
function urlAppend(domain, uri)
{
	if( domain.length>=1 )
		return domain + (domain.charAt(domain.length-1)!='/' ? '/' : '') + uri;
	else
		return uri;
}

// call operation on all elements of array2 which are not in array1 using a compare function
function arrayOpCompare(array1, array2, compare_func, operation_func)
{
    for( var i=0 ; i<array1.length ; ++i )
    {
        found_in_array2 = false;
        for( var j=0 ; j<array2.length ; ++j )
        {
            if( compare_func(array1[i], array2[j]) )
                found_in_array2 = true;
        }
        
        if( !found_in_array2 )
            operation_func(i, array1[i]);
    }
}

// returns icons and state ranks for job states
const jobStates = new function() {
	// define job states (colors) and their corresponding icon, feel free to add more here
	// this array is also used to determine the rank of a job state, low array index refers to a high rank
	// filter refers to the name of the filter setting (whether to show matching jobs or not)
	// name is used for notifications about job changes
	let states = [
		{ color: 'red_anime', 		icon: 'clock', 	filter: 'show_running_jobs', 	name: 'running' },
		{ color: 'yellow_anime', 	icon: 'clock', 	filter: 'show_running_jobs', 	name: 'running' },
		{ color: 'blue_anime', 		icon: 'clock', 	filter: 'show_running_jobs', 	name: 'running' },
		{ color: 'grey_anime', 		icon: 'clock', 	filter: 'show_running_jobs', 	name: 'running' },
		{ color: 'aborted_anime',   icon: 'clock',  filter: 'show_running_jobs',    name: 'running' },
		{ color: 'red', 			icon: 'red', 	filter: 'show_failed_jobs',		name: 'failed' },
		{ color: 'yellow', 			icon: 'yellow', filter: 'show_unstable_jobs',	name: 'unstable' },
		{ color: 'blue', 			icon: 'blue', 	filter: 'show_successful_jobs', name: 'successful' },
		{ color: 'grey', 			icon: 'grey', 	filter: 'show_neverbuilt_jobs', name: 'never built' },
		{ color: 'aborted', 		icon: 'grey', 	filter: 'show_aborted_jobs',	name: 'aborted' },
		{ color: 'disabled', 		icon: 'grey', 	filter: 'show_disabled_jobs',	name: 'disabled' }
	];

	// returns the rank of a job state, highest rank is 0, -1 means that the job state is unknown
	// this is used to determine the state of the overall indicator which shows the state of the highest ranked job
	this.getRank = function(job_color)
	{
		for( let i=0 ; i<states.length ; ++i )
		{
			if( job_color==states[i].color ) return i;
		}
		return -1;
	};

	// returns the corresponding icon name of a job state
	this.getIcon = function(job_color, with_green_balls)
	{
		for( let i=0 ; i<states.length ; ++i )
		{
		    // use green balls plugin if actived
		    if( with_green_balls && job_color=='blue' ) return 'jenkins_green';
		    
		    // if not just return a regular icon
			else if( job_color==states[i].color ) return 'jenkins_' + states[i].icon;
		}
		// if job color is unknown, use the grey icon
		global.log('unkown color: ' + job_color);
		return 'jenkins_grey';
	};

	// returns the corresponding icon name of a job state
	this.getFilter = function(job_color)
	{
		for( let i=0 ; i<states.length ; ++i )
		{
			if( job_color==states[i].color ) return states[i].filter;
		}
		// if job color is unknown, use the filter setting for disabled jobs
		global.log('unkown color: ' + job_color);
		return 'show-disabled-jobs';
	};
	
	// returns the corresponding icon name of a job state
	this.getName = function(job_color)
	{
		for( let i=0 ; i<states.length ; ++i )
		{
			if( job_color==states[i].color ) return _(states[i].name);
		}
		// if job color is unknown, use the filter setting for disabled jobs
		global.log('unkown color: ' + job_color);
		return 'unknown';
	};

	// returns the default job state to use for overall indicator
	this.getDefaultState = function()
	{
		// return lowest ranked job state
		return states[states.length-1].color;
	};

	// return the color of the error state for the overall indicator
	this.getErrorState = function()
	{
		return "jenkins_red";
	};
};

// source for handling job notifications 
const JobNotificationSource = new Lang.Class({
    Name: 'JobNotificationSource',
    Extends: MessageTray.Source,

    _init: function(title) {
    	// set notification source title
        this.parent(title);

		// set notification source icon
        this._setSummaryIcon(this.createNotificationIcon());
        
        // add myself to the message try
        SessionMessageTray.add(this);
    },

	// set jenkins logo for notification source icon
    createNotificationIcon: function() {
        return new St.Icon({ icon_name: 'jenkins_headshot',
                             icon_type: St.IconType.FULLCOLOR,
                             icon_size: ICON_SIZE_INDICATOR });
    },

	// gets called when a notification is clicked
    open: function(notification) {
    	// close the clicked notification
        notification.destroy();
    }
});

// server name and link in the popup menu
const ServerPopupMenuItem = new Lang.Class({
    Name: 'ServerPopupMenuItem',
    Extends: PopupMenu.PopupBaseMenuItem,

    _init: function(settings, params) {
        this.parent(params);
        
        this.settings = settings;
        
        this.box = new St.BoxLayout({ style_class: 'popup-combobox-item' });
        this.icon = new St.Icon({   icon_name: 'jenkins_headshot',
                                    icon_type: St.IconType.FULLCOLOR,
                                    icon_size: ICON_SIZE_INDICATOR,
                                    style_class: "system-status-icon" });
        this.label = new St.Label({ text: this.settings.name });

        this.box.add(this.icon);
        this.box.add(this.label);
        this.addActor(this.box);
        
        // clicking the server menu item opens the servers web frontend with default browser
        event_signals.push( this.connect("activate", Lang.bind(this, function(){
            Gio.app_info_launch_default_for_uri(this.settings.jenkins_url, global.create_app_launch_context());
        })) );
    },

    // update menu item label (server name)
    updateSettings: function(settings) {
        this.settings = settings;
        this.label.text = this.settings.name;
    },
    
    // destroys the server popup menu item
    destroy: function() {
        this.icon.destroy();
        this.label.destroy();
        this.box.destroy();
        
        this.parent();
    }
});

// represent a job in the popup menu with icon and job name
const JobPopupMenuItem = new Lang.Class({
	Name: 'JobPopupMenuItem',
	Extends: PopupMenu.PopupBaseMenuItem,

    _init: function(menu, job, notification_source, settings, params) {
    	this.parent(params);
    	
		this.menu = menu;
    	this.notification_source = notification_source;
    	this.settings = settings;
    	
        this.box = new St.BoxLayout({ style_class: 'popup-combobox-item' });

		// icon representing job state
        this.icon = new St.Icon({ 	icon_name: jobStates.getIcon(job.color, this.settings.green_balls_plugin),
                                	icon_type: St.IconType.FULLCOLOR,
                                	icon_size: ICON_SIZE_INDICATOR,
                                	style_class: "system-status-icon" });
	
		// button used to trigger the job
        this.icon_build = new St.Icon({ icon_name: 'jenkins_clock',
                                		icon_type: St.IconType.FULLCOLOR,
                                		icon_size: ICON_SIZE_INDICATOR,
                                		style_class: "system-status-icon" });

		this.button_build = new St.Button({ child: this.icon_build });
		
		event_signals.push( this.button_build.connect("clicked", Lang.bind(this, function(){
			// request to trigger the build
			let request = Soup.Message.new('GET', urlAppend(this.settings.jenkins_url, 'job/' + this.getJobName() + '/build'));
			
			// append authentication header (if necessary)
			if( this.settings.use_authentication )
				request.request_headers.append('Authorization', 'Basic ' + Glib.base64_encode(this.settings.auth_user + ':' + this.settings.api_token));

			if( request )
			{
				// kick off request
				_httpSession.queue_message(request, Lang.bind(this, function(_httpSession, message) {
					// we could try to refresh all jobs here but jenkins delays builds by 5 seconds so we wont see any difference
				}));
			}

			// close this menu
			this.menu.close();
		})) );

		// menu item label (job name)
		this.label = new St.Label({ text: job.name });

        this.box.add(this.icon);
        this.box.add(this.label);
        this.addActor(this.box);

		this.addActor(this.button_build);
        
        // clicking a job menu item opens the job in web frontend with default browser
        event_signals.push( this.connect("activate", Lang.bind(this, function(){
            Gio.app_info_launch_default_for_uri(urlAppend(this.settings.jenkins_url, 'job/' + this.getJobName()), global.create_app_launch_context());
        })) );
	},

	// return job name
	getJobName: function() {
		return this.label.text;
	},

	// update menu item text and icon
	updateJob: function(job) {
		// notification for finished job if job icon used to be clock (if enabled in settings)
		if( this.settings.notification_finished_jobs && this.icon.icon_name=='jenkins_clock' && jobStates.getIcon(job.color, this.settings.green_balls_plugin)!='jenkins_clock' )
		{
			// create notification source first time we have to display notifications or if server name changed
			if( this.notification_source===undefined || this.notification_source.title!==this.settings.name )
				this.notification_source = new JobNotificationSource(this.settings.name);
			
			// create notification for the finished job
		    let notification = new MessageTray.Notification(this.notification_source, _('Job finished building'), _('Your Jenkins job %s just finished building (<b>%s</b>).').format(job.name, jobStates.getName(job.color)), {
		    	bannerMarkup: true,
		    	icon: new St.Icon({ icon_name: jobStates.getIcon(job.color, this.settings.green_balls_plugin),
                                	icon_type: St.IconType.FULLCOLOR,
                                	icon_size: ICON_SIZE_NOTIFICATION,
                                	style_class: "system-status-icon" })
		    });
		    
		    // use transient messages if persistent messages are disabled in settings
		    if( this.settings.stack_notifications==false )
		    	notification.setTransient(true);
		    
		    // notify the user
		    this.notification_source.notify(notification);
		}
		
		this.label.text = job.name;
		this.icon.icon_name = jobStates.getIcon(job.color, this.settings.green_balls_plugin);
	},
	
	// update settings
	updateSettings: function(settings) {
	    this.settings = settings;
	},
	
	// destroys the job popup menu item
	destroy: function() {
		this.icon.destroy();
		this.label.destroy();
		this.box.destroy();
		
		this.parent();
	}
});

// manages jobs popup menu items
const ServerPopupMenu = new Lang.Class({
	Name: 'ServerPopupMenu',
	Extends: PopupMenu.PopupMenu,

	_init: function(indicator, sourceActor, arrowAlignment, arrowSide, notification_source, settings) {
		this.parent(sourceActor, arrowAlignment, arrowSide);
		
		this.indicator = indicator;
		this.notification_source = notification_source;
		this.settings = settings;
	},

	// insert, delete and update all job items in popup menu
	updateJobs: function(new_jobs) {
		// provide error message if no jobs were found
		if( new_jobs.length==0 )
		{
			_indicators.showError(_("No jobs found"));
			return;
		}

		// remove previous error message
		if( this._getMenuItems().length==5 && this._getMenuItems()[2] instanceof PopupMenu.PopupMenuItem )
			this._getMenuItems()[2].destroy();

		// check all new job items
		for( let i=0 ; i<new_jobs.length ; ++i )
		{
			// try to find matching job
			let matching_job = null;
			for( let j = 2 ; j<this._getMenuItems().length-2 ; ++j )
			{
				if( new_jobs[i].name==this._getMenuItems()[j].getJobName() )
				{
					// we found a matching job
					matching_job = this._getMenuItems()[j];
					break;
				}
			}

			// update matched job
			if( matching_job!=null )
			{
				matching_job.updateJob(new_jobs[i]);
			}
			// otherwise insert as new job
			else
			{
				this.addMenuItem(new JobPopupMenuItem(this, new_jobs[i], this.notification_source, this.settings), i+2);
			}
		}
		
    	// check for jobs that need to be removed
		for( let j = 2 ; j<this._getMenuItems().length-2 ; ++j )
		{
			let job_found = false;
			for( let i=0 ; i<new_jobs.length ; ++i )
			{
				if( new_jobs[i].name==this._getMenuItems()[j].getJobName() )
				{
					job_found = true;
					break;
				}
			}

			// remove job if not found
			if( !job_found )
			{
				this._getMenuItems()[j].destroy();
			}
		}
	},
	
	// update settings
	updateSettings: function(settings) {
	    this.settings = settings;
	    
	    // push new settings to job menu items
	    for( let j = 2 ; j<this._getMenuItems().length-2 ; ++j )
	        this._getMenuItems()[j].updateSettings(this.settings);
	}
});

// represents the indicator in the top menu bar
const JenkinsIndicator = new Lang.Class({
    Name: 'JenkinsIndicator',
    Extends: PanelMenu.Button,

    _init: function(settings) {
    	this.parent(0.25, "Jenkins Indicator", false );
    	
    	// the number of the server this indicator refers to
    	this.settings = settings;
    	
    	// start off with no jobs to display
    	this.jobs = [];
    	
    	// we will use this later to add a notification source as soon as a notification needs to be displayed
        this.notification_source;
    	
    	// lock used to prevent multiple parallel update requests
    	this._isRequesting = false;
    	
		// start off with a blue overall indicator
        this._iconActor = new St.Icon({ icon_name: jobStates.getIcon(jobStates.getDefaultState(), this.settings.green_balls_plugin),
                                        icon_type: St.IconType.FULLCOLOR,
                                        icon_size: ICON_SIZE_INDICATOR,
                                        style_class: "system-status-icon" });
        this.actor.add_actor(this._iconActor);

        // add jobs popup menu
		this.setMenu(new ServerPopupMenu(this, this.actor, 0.25, St.Side.TOP, this.notification_source, this.settings));

		// add server menu item
		this.serverMenuItem = new ServerPopupMenuItem(this.settings);
		this.menu.addMenuItem(this.serverMenuItem);
		
		// add seperators to popup menu
		this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
		this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

		// add link to settings dialog
		this._menu_settings = new PopupMenu.PopupMenuItem(_("Settings"));
		event_signals.push( this._menu_settings.connect("activate", function(){
			// call gnome settings tool for this extension
			let app = Shell.AppSystem.get_default().lookup_app("gnome-shell-extension-prefs.desktop");
			if( app!=null )
				app.launch(global.display.get_current_time_roundtrip(), ['extension:///' + Me.uuid], -1, null);
		}) );
		this.menu.addMenuItem(this._menu_settings);

        // refresh when indicator is clicked
        event_signals.push( this.actor.connect("button-press-event", Lang.bind(this, this.request)) );

        // enter main loop for refreshing
        this._mainloopInit();
    },
    
    _mainloopInit: function() {
        // create new main loop
        this._mainloop = Mainloop.timeout_add(this.settings.autorefresh_interval*1000, Lang.bind(this, function(){
            // request new job states if auto-refresh is enabled
            if( this.settings.autorefresh )
                this.request();

            // returning true is important for restarting the mainloop after timeout
            return true;
        }));
    },

	// request local jenkins server for current state
	request: function() {
		// only update if no update is currently running
		if( !this._isRequesting )
		{
			this._isRequesting = true;
			// ajax request to local jenkins server
			let request = Soup.Message.new('GET', urlAppend(this.settings.jenkins_url, 'api/json'));
			
			// append authentication header (if necessary)
			// jenkins only supports preemptive authentication so we have to provide authentication info on first request
			if( this.settings.use_authentication )
				request.request_headers.append('Authorization', 'Basic ' + Glib.base64_encode(this.settings.auth_user + ':' + this.settings.api_token));

			if( request )
			{
				_httpSession.queue_message(request, Lang.bind(this, function(_httpSession, message) {
					// http error
					if( message.status_code!==200 )
					{
						this.showError(_("Invalid Jenkins CI Server web frontend URL (HTTP Error %s)").format(message.status_code));
					}
					// http ok
					else
					{
						// parse json
						let jenkinsState = JSON.parse(request.response_body.data);
	
						// update jobs
						this.jobs = jenkinsState.jobs;
						
						// update indicator (icon and popupmenu contents)
						this.update();
					}
					
					// we're done updating and ready for the next request
					this._isRequesting = false;
				}));
			}
			// no valid url was provided in settings dialog
			else
			{
				this.showError(_("Invalid Jenkins CI Server web frontend URL"));
				
				// we're done updating and ready for the next request
				this._isRequesting = false;
			}
		}
	},

	// update indicator icon and popupmenu contents
	update: function() {
		// filter jobs to be shown
		let displayJobs = this._filterJobs(this.jobs);

		// update popup menu
		this.menu.updateJobs(displayJobs);

		// update overall indicator icon

		// default state of overall indicator
		let overallState = jobStates.getDefaultState();

		// set state to red if there are no jobs
		if( displayJobs.length<=0 )
			overallState = jobStates.getErrorState();
		else
		{
			// determine jobs overall state for the indicator
			for( let i=0 ; i<displayJobs.length ; ++i )
			{
				// set overall job state to highest ranked (most important) state
				if( jobStates.getRank(displayJobs[i].color)>-1 && jobStates.getRank(displayJobs[i].color)<jobStates.getRank(overallState) )
					overallState = displayJobs[i].color;
			}
		}

		// set new overall indicator icon representing current jenkins state
		this._iconActor.icon_name = jobStates.getIcon(overallState, this.settings.green_balls_plugin);
	},

	// filters jobs according to filter settings
	_filterJobs: function(jobs) {
		jobs = jobs || [];
		let filteredJobs = [];

		for( var i=0 ; i<jobs.length ; ++i )
		{
			// filter jobs based on user settings ('state' or 'selected jobs')
            if (this.settings["selected_projects"].split(/\W*,\W*/).indexOf(jobs[i].name) >= 0 &&
                this.settings[jobStates.getFilter(jobs[i].color)])
            {
              filteredJobs[filteredJobs.length] = jobs[i]
            }
		}

		return filteredJobs;
	},
	
	// update settings
	updateSettings: function(settings) {
	    this.settings = settings;
	    
	    // update server menu item
	    this.menu.updateSettings(this.settings);
	    this.serverMenuItem.updateSettings(this.settings);
	    
	    // refresh main loop
	    Mainloop.source_remove(this._mainloop);
	    this._mainloopInit();

	    this.update();
	},

	// displays an error message in the popup menu
	showError: function(text) {
		// set default error message if none provided
		text = text || "unknown error";

		// remove all job menu entries and previous error messages
		while( this.menu._getMenuItems().length>4 )
			this.menu._getMenuItems()[2].destroy();

		// show error message in popup menu
		this.menu.addMenuItem(new PopupMenu.PopupMenuItem(_("Error") + ": " + text, {style_class: 'error'}), 2);

		// set indicator state to error
		this._iconActor.icon_name = jobStates.getIcon(jobStates.getErrorState(), this.settings.green_balls_plugin);
	},

	// destroys the indicator
	destroy: function() {
		// destroy the mainloop used for updating the indicator
		Mainloop.source_remove(this._mainloop);
		
		// destroy notification source if used
		if( this.notification_source )
			this.notification_source.destroy();

		// call parent destroy function
		this.parent();
	}
});

function createIndicator(server_num)
{
    // create indicator and add to status area
    _indicators[server_num] = new JenkinsIndicator(settingsJSON['servers'][server_num]);
    Main.panel.addToStatusArea("jenkins-indicator-"+settingsJSON['servers'][server_num]['id'], _indicators[server_num]);
}

function init(extensionMeta) {
    // add include path for icons
    let theme = imports.gi.Gtk.IconTheme.get_default();
    theme.append_search_path(extensionMeta.path + "/icons");
    
    // load localization dictionaries
    Convenience.initTranslations();
    
    // load extension settings
    settings = Convenience.getSettings();
    settingsJSON = Settings.getSettingsJSON(settings);
}

function enable() {
    // we need to add indicators in reverse order so they appear from left to right
	for( let i=settingsJSON['servers'].length-1 ; i>=0 ; --i )
        createIndicator(i);
    
    // react to changing settings by adding/removing indicators if necessary
    event_signals.push( settings.connect('changed::settings-json', function(){
        settingsJSON_old = settingsJSON;
        settingsJSON = Settings.getSettingsJSON(settings);

        // destroy deleted indicators
        arrayOpCompare(settingsJSON_old['servers'], settingsJSON['servers'], function(a, b){
            return a['id']==b['id'];
        }, function(index, element){
            _indicators[index].destroy();
            _indicators.splice(index,1);
        });
        
        // create new indicators
        arrayOpCompare(settingsJSON['servers'], settingsJSON_old['servers'], function(a, b){
            return a['id']==b['id'];
        }, function(index, element){
            createIndicator(index);
        });
        
        // update all indicators
        for( let i=0 ; i<_indicators.length ; ++i )
        {
            _indicators[i].updateSettings(settingsJSON['servers'][i]);
            _indicators[i].request();
        }
    }) );
}

function disable() {
    for( var i=0 ; i<_indicators.length ; ++i )
        _indicators[i].destroy();

    _indicators = [];
    
    // disconnect all signal listeners
    for( var i=0 ; i<event_signals.length ; ++i )
    	settings.disconnect(event_signals[i]);
}
