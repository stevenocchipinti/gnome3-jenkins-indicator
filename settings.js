const Params = imports.misc.params;

// default settings for new servers
let DefaultSettings = {
    "servers": [
        {
            "id": 1,
            "name": "Default",
            "jenkins_url": "http://localhost:8080/",
            "green_balls_plugin": false,

            "autorefresh": true,
            "autorefresh_interval": 5,
            
            "notification_finished_jobs": true,
            "stack_notifications": false,
            
            "show_running_jobs": true,
            "show_successful_jobs": true,
            "show_unstable_jobs": true,
            "show_failed_jobs": true,
            "show_neverbuilt_jobs": false,
            "show_disabled_jobs": false,
            "show_aborted_jobs": false
        }
    ]
}

// helper to prevent weird errors if possible settings change in future updates by using default settings
function getSettingsJSON(settings)
{
    return Params.parse(JSON.parse(settings.get_string("settings-json")), DefaultSettings, true);
}