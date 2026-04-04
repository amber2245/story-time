(function () {
    const testBox = document.createElement('div');
    testBox.textContent = 'STORY TIME JS LOADED';
    testBox.style.position = 'fixed';
    testBox.style.top = '120px';
    testBox.style.left = '20px';
    testBox.style.zIndex = '10000';
    testBox.style.padding = '12px 16px';
    testBox.style.background = '#c62828';
    testBox.style.color = '#ffffff';
    testBox.style.fontSize = '16px';
    testBox.style.fontWeight = '700';
    testBox.style.borderRadius = '12px';
    testBox.style.boxShadow = '0 6px 20px rgba(0, 0, 0, 0.3)';
    document.body.appendChild(testBox);

    console.log('[story-time] JS loaded test');
})();