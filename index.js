(function () {
    const PLUGIN_ID = 'story-time';
    const STORAGE_KEY = 'story-time-state';
    const DEFAULT_TIME = '07:30';
    const DEFAULT_ADVANCE_MINUTES = 5;
    const CHECK_INTERVAL = 1500;

    let clockElement = null;
    let state = loadState();
    let lastMessageCount = 0;
    let isInitialized = false;

    function loadState() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (!saved) {
                return {
                    currentTime: DEFAULT_TIME,
                };
            }

            const parsed = JSON.parse(saved);
            return {
                currentTime: isValidTime(parsed.currentTime) ? parsed.currentTime : DEFAULT_TIME,
            };
        } catch (error) {
            console.warn('[story-time] Failed to load state:', error);
            return {
                currentTime: DEFAULT_TIME,
            };
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

    function getCurrentTime() {
        return state.currentTime;
    }

    function setCurrentTime(newTime) {
        if (!isValidTime(newTime)) {
            return false;
        }

        state.currentTime = newTime;
        saveState();
        renderClock();
        return true;
    }

    function advanceTime(minutes) {
        const currentMinutes = timeToMinutes(getCurrentTime());
        const nextTime = minutesToTime(currentMinutes + minutes);
        state.currentTime = nextTime;
        saveState();
        renderClock();
    }

    function renderClock() {
        if (!clockElement) {
            return;
        }

        clockElement.textContent = state.currentTime;
        clockElement.title = 'Tap to edit story time';
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
        if (document.getElementById(PLUGIN_ID)) {
            clockElement = document.getElementById(PLUGIN_ID);
            renderClock();
            return;
        }

        clockElement = document.createElement('button');
        clockElement.id = PLUGIN_ID;
        clockElement.className = 'story-time-bar';
        clockElement.type = 'button';
        clockElement.addEventListener('click', handleManualEdit);

        document.body.appendChild(clockElement);
        renderClock();
    }

    function getMessageElements() {
        return document.querySelectorAll('.mes');
    }

    function estimateAdvanceMinutes() {
        return DEFAULT_ADVANCE_MINUTES;
    }

    function processMessageChanges() {
        const messages = getMessageElements();
        const currentCount = messages.length;

        if (!isInitialized) {
            lastMessageCount = currentCount;
            isInitialized = true;
            return;
        }

        if (currentCount > lastMessageCount) {
            const newMessageCount = currentCount - lastMessageCount;

            for (let i = 0; i < newMessageCount; i += 1) {
                advanceTime(estimateAdvanceMinutes());
            }
        }

        lastMessageCount = currentCount;
    }

    function startWatchingMessages() {
        processMessageChanges();
        window.setInterval(processMessageChanges, CHECK_INTERVAL);
    }

    function init() {
        createClock();
        startWatchingMessages();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
