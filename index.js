(function () {
    const PLUGIN_ID = 'story-time';
    const DEFAULT_TIME = '07:30';

    function createClock() {
        if (document.getElementById(PLUGIN_ID)) {
            return;
        }

        const clock = document.createElement('div');
        clock.id = PLUGIN_ID;
        clock.className = 'story-time-bar';
        clock.textContent = DEFAULT_TIME;

        document.body.appendChild(clock);
    }

    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', createClock);
        } else {
            createClock();
        }
    }

    init();
})();
