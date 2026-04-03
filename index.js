(function () {
    const CLOCK_ID = 'story-time-clock';
    const ADVANCE_ID = 'story-time-advance';
    const STORAGE_KEY = 'story-time-state';
    const DEFAULT_TIME = '07:30';
    const DEFAULT_ADVANCE_MINUTES = 5;

    let clockElement = null;
    let advanceElement = null;
    let state = loadState();

    function loadState() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (!saved) {
                return { currentTime: DEFAULT_TIME };
            }

            const parsed = JSON.parse(saved);
            return {
                currentTime: isValidTime(parsed.currentTime) ? parsed.currentTime : DEFAULT_TIME,
            };
        } catch (error) {
            console.warn('[story-time] Failed to load state:', error);
            return { currentTime: DEFAULT_TIME };
        }
    }

    function saveState() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function isValidTime(value) {
        return typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
    }

    function timeToMinutes(timeString) {
        const [hours, minutes] = timeString.split(':').map(Number);
        return hours * 60 + minutes;
    }

    function minutesToTime(totalMinutes) {
        const minutesInDay = 24 * 60;
        const normalized = ((totalMinutes % minutesInDay) + minutesInDay) % minutesInDay;
        const hours = Math.floor(normalized / 60);
        const minutes = normalized % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }

    function setCurrentTime(newTime) {
        if (!isValidTime(newTime)) {
            return false;
        }

        state.currentTime = newTime;
        saveState();
        render();
        return true;
    }

    function advanceTime(minutes) {
        const currentMinutes = timeToMinutes(state.currentTime);
        state.currentTime = minutesToTime(currentMinutes + minutes);
        saveState();
        render();
        console.log('[story-time] advanced to', state.currentTime);
    }

    function render() {
        if (clockElement) {
            clockElement.textContent = state.currentTime;
        }
    }

    function handleManualEdit() {
        const input = window.prompt('Set story time (HH:MM)', state.currentTime);

        if (input === null) {
            return;
        }

        const normalized = input.trim();

        if (!setCurrentTime(normalized)) {
            window.alert('Invalid time format. Use HH:MM, for example 08:45.');
        }
    }

    function createClock() {
        const existing = document.getElementById(CLOCK_ID);
        if (existing) {
            clockElement = existing;
            return;
        }

        clockElement = document.createElement('button');
        clockElement.id = CLOCK_ID;
        clockElement.className = 'story-time-bar';
        clockElement.type = 'button';
        clockElement.addEventListener('click', handleManualEdit);

        document.body.appendChild(clockElement);
    }

    function createAdvanceButton() {
        const existing = document.getElementById(ADVANCE_ID);
        if (existing) {
            advanceElement = existing;
            return;
        }

        advanceElement = document.createElement('button');
        advanceElement.id = ADVANCE_ID;
        advanceElement.className = 'story-time-advance';
        advanceElement.type = 'button';
        advanceElement.textContent = '+5m';
        advanceElement.addEventListener('click', function () {
            advanceTime(DEFAULT_ADVANCE_MINUTES);
        });

        document.body.appendChild(advanceElement);
    }

    function init() {
        createClock();
        createAdvanceButton();
        render();
        console.log('[story-time] initialized');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();