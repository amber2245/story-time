(function () {
    const PLUGIN_ID = 'story-time';
    const STORAGE_KEY = 'story-time-state';
    const DEFAULT_TIME = '07:30';
    const DEFAULT_ADVANCE_MINUTES = 5;

    let clockElement = null;
    let observer = null;
    let state = loadState();
    let processedMessageIds = new Set();

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
        const parts = timeString.split(':').map(Number);
        const hours = parts[0];
        const minutes = parts[1];
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
        renderClock();
        return true;
    }

    function advanceTime(minutes) {
        const currentMinutes = timeToMinutes(state.currentTime);
        state.currentTime = minutesToTime(currentMinutes + minutes);
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
        const existing = document.getElementById(PLUGIN_ID);
        if (existing) {
            clockElement = existing;
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
        const selectors = [
            '[data-mesid]',
            '.mes',
            '.message',
            '.mes_block',
        ];

        for (const selector of selectors) {
            const elements = Array.from(document.querySelectorAll(selector));
            if (elements.length > 0) {
                return elements;
            }
        }

        return [];
    }

    function getMessageKey(element, index) {
        const mesId = element.getAttribute('data-mesid');
        if (mesId) {
            return `mesid:${mesId}`;
        }

        return `index:${index}:${element.textContent.slice(0, 50)}`;
    }

    function estimateAdvanceMinutes() {
        return DEFAULT_ADVANCE_MINUTES;
    }

    function seedProcessedMessages() {
        const messages = getMessageElements();
        processedMessageIds = new Set(
            messages.map((element, index) => getMessageKey(element, index))
        );
        console.log('[story-time] seeded messages:', processedMessageIds.size);
    }

    function scanForNewMessages() {
        const messages = getMessageElements();
        let newMessageCount = 0;
        const nextProcessed = new Set();

        messages.forEach((element, index) => {
            const key = getMessageKey(element, index);
            nextProcessed.add(key);

            if (!processedMessageIds.has(key)) {
                newMessageCount += 1;
            }
        });

        if (newMessageCount > 0) {
            console.log('[story-time] new messages detected:', newMessageCount);
            for (let i = 0; i < newMessageCount; i += 1) {
                advanceTime(estimateAdvanceMinutes());
            }
        }

        processedMessageIds = nextProcessed;
    }

    function startWatchingMessages() {
        seedProcessedMessages();

        if (observer) {
            observer.disconnect();
        }

        observer = new MutationObserver(() => {
            scanForNewMessages();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });

        console.log('[story-time] observer started');
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