(function () {
  'use strict';
  const catalogNode = document.getElementById('videoCatalog');
  if (!catalogNode) return;
  const catalog = JSON.parse(catalogNode.textContent);
  const root = new URL(catalog.root, location.href);
  const topics = catalog.topics.map(function (item) {
    return Object.assign({}, item, {
      page: new URL(item.slug + '/', root).href,
      media: item.file ? new URL(item.file, root).href : null,
      cover: item.cover ? new URL(item.cover, root).href : null
    });
  });
  const stage = document.querySelector('.video-stage');
  const directory = document.getElementById('videoDirectory') || document.querySelector('.video-directory');
  const warmedPages = new Set();
  const attemptedMedia = new Set();
  let registration;
  let worker;
  let activeVideo = document.getElementById('trainingVideo');
  let activeTopic = topicAt(location.href);
  let preview = document.getElementById('videoPreview');
  let standby;
  let intent;
  let job;
  let scheduleTimer;
  let loadingTimer;
  let frameTimer;
  let frameRequest;
  let pictureIssue = false;
  let failed = false;
  let requested = false;
  let resumeAt = 0;
  const status = document.getElementById('videoStatus');
  const text = document.getElementById('statusText');
  const retry = document.getElementById('retryVideo');
  const direct = document.getElementById('directVideo');

  function topicAt(url) {
    const path = new URL(url, root).pathname.replace(/index\.html$/, '');
    return topics.find(function (item) { return new URL(item.page).pathname === path; });
  }

  function send(type, url) {
    if (worker) worker.postMessage({ type, url });
  }

  function cachePage(url) {
    if (!worker || warmedPages.has(url)) return;
    warmedPages.add(url);
    send('PAGE', url);
  }

  function backgroundAllowed() {
    const connection = navigator.connection;
    return !document.hidden && !(connection &&
      (connection.saveData || /(^|-)2g$/.test(connection.effectiveType)));
  }

  function enoughBuffer() {
    if (!activeVideo || failed || pictureIssue || activeVideo.seeking) return false;
    if (activeVideo.ended) return true;
    for (let i = 0; i < activeVideo.buffered.length; i += 1) {
      if (activeVideo.buffered.start(i) <= activeVideo.currentTime &&
          activeVideo.buffered.end(i) >= Math.min(activeVideo.duration - 0.1, activeVideo.currentTime + 8)) {
        return true;
      }
    }
    return false;
  }

  function fullyBuffered() {
    if (activeVideo.ended) return true;
    return activeVideo.buffered.length === 1 && activeVideo.buffered.start(0) < 0.1 &&
      activeVideo.buffered.end(0) >= activeVideo.duration - 0.1;
  }

  function cancelWarm() {
    window.clearTimeout(scheduleTimer);
    scheduleTimer = null;
    if (worker) send('CANCEL');
    if (job) {
      attemptedMedia.delete(job.url);
      job = null;
    }
  }

  function discardStandby() {
    if (!standby) return;
    standby.video.pause();
    standby.video.removeAttribute('src');
    standby.video.load();
    standby.video.remove();
    standby = null;
  }

  function prepareStandby(topic) {
    if (!stage || topic === activeTopic || (standby && standby.topic === topic)) return;
    discardStandby();
    const video = makeVideo(topic);
    video.hidden = true;
    video.removeAttribute('id');
    video.setAttribute('aria-hidden', 'true');
    stage.appendChild(video);
    standby = { topic, video };
  }

  function nextTopic() {
    if (intent && intent !== activeTopic && intent.media) return intent;
    const index = topics.indexOf(activeTopic);
    return topics.slice(index + 1).find(function (item) { return item.media; });
  }

  function scheduleWarm() {
    if (!activeTopic || !activeVideo || !backgroundAllowed() || !enoughBuffer() || job) return;
    const next = nextTopic();
    let candidate = next;
    if ((!intent || attemptedMedia.has(intent.media)) && worker && fullyBuffered() &&
        !attemptedMedia.has(activeTopic.media)) candidate = activeTopic;
    if (!candidate || !candidate.media || attemptedMedia.has(candidate.media)) return;
    attemptedMedia.add(candidate.media);
    cachePage(candidate.page);
    if (candidate.cover) cachePage(candidate.cover);
    if (!worker) {
      prepareStandby(candidate);
      return;
    }
    const token = { url: candidate.media };
    job = token;
    const channel = new MessageChannel();
    const timeout = window.setTimeout(function () {
      channel.port1.close();
      if (job === token) {
        cancelWarm();
        attemptedMedia.add(token.url);
      }
    }, 45000);
    channel.port1.onmessage = function (event) {
      window.clearTimeout(timeout);
      channel.port1.close();
      if (job !== token) return;
      job = null;
      if (event.data.ok && backgroundAllowed()) prepareStandby(candidate);
      deferWarm();
    };
    worker.postMessage({ type: 'WARM', url: candidate.media }, [channel.port2]);
  }

  function deferWarm() {
    window.clearTimeout(scheduleTimer);
    scheduleTimer = window.setTimeout(function () {
      scheduleTimer = null;
      scheduleWarm();
    }, 1200);
  }

  function showStatus(value, recovery) {
    if (!status) return;
    text.textContent = value;
    retry.hidden = !recovery;
    direct.hidden = !recovery;
    status.hidden = false;
  }

  function hideStatus() {
    window.clearTimeout(loadingTimer);
    if (status && !failed && !pictureIssue) status.hidden = true;
  }

  function removePreview() {
    if (preview) {
      preview.remove();
      preview = null;
    }
    activeVideo.removeAttribute('poster');
  }

  function stopPictureWatch(video) {
    window.clearTimeout(frameTimer);
    if (frameRequest !== undefined && video.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(frameRequest);
    }
    frameRequest = undefined;
  }

  function watchPicture(video) {
    stopPictureWatch(video);
    const startedAt = video.currentTime;
    const canObserve = typeof video.requestVideoFrameCallback === 'function';
    video.dataset.pictureState = 'waiting';
    if (canObserve) {
      const onFrame = function (_, metadata) {
        frameRequest = undefined;
        if (video !== activeVideo || video.paused) return;
        if (metadata.mediaTime > startedAt + 0.04) {
          video.dataset.pictureState = 'rendered';
          pictureIssue = false;
          window.clearTimeout(frameTimer);
          hideStatus();
        } else {
          frameRequest = video.requestVideoFrameCallback(onFrame);
        }
      };
      frameRequest = video.requestVideoFrameCallback(onFrame);
    }
    frameTimer = window.setTimeout(function () {
      if (video !== activeVideo || video.paused || video.ended || document.hidden || failed) return;
      if (video.currentTime > startedAt + 0.5 &&
          ((canObserve && video.dataset.pictureState !== 'rendered') || video.videoWidth === 0)) {
        pictureIssue = true;
        video.dataset.pictureState = 'no-picture';
        cancelWarm();
        showStatus('The video picture could not be confirmed. Retry or open the MP4 directly.', true);
      }
    }, 5000);
  }

  function showFailure() {
    failed = true;
    cancelWarm();
    stopPictureWatch(activeVideo);
    removePreview();
    window.clearTimeout(loadingTimer);
    showStatus('Video could not load. Check your connection, retry or open the MP4 directly.', true);
  }

  function loading() {
    cancelWarm();
    discardStandby();
    if (!requested || activeVideo.paused || failed || pictureIssue) return;
    window.clearTimeout(loadingTimer);
    showStatus('Buffering video…', false);
    loadingTimer = window.setTimeout(function () {
      if (!activeVideo.paused && activeVideo.readyState < 3 && !failed && !pictureIssue) {
        showStatus('Loading is taking longer. You can keep waiting or retry.', true);
      }
    }, 8000);
  }

  function play() {
    const video = activeVideo;
    removePreview();
    showStatus('Starting video…', false);
    const promise = video.play();
    if (promise && promise.catch) promise.catch(function (error) {
      if (video !== activeVideo || error.name === 'AbortError') return;
      if (error.name === 'NotAllowedError') {
        showStatus('Tap the video play button to start playback.', false);
      } else {
        showFailure();
      }
    });
  }

  function bindVideo(video) {
    video.addEventListener('play', function () {
      if (video !== activeVideo) return;
      removePreview();
      requested = true;
      failed = false;
      watchPicture(video);
      if (video.readyState < 3) loading();
    });
    video.addEventListener('playing', function () {
      if (video !== activeVideo) return;
      if (!video.requestVideoFrameCallback || video.dataset.pictureState === 'rendered') hideStatus();
      deferWarm();
    });
    video.addEventListener('waiting', function () { if (video === activeVideo) loading(); });
    video.addEventListener('stalled', function () {
      if (video === activeVideo && video.readyState < 3) loading();
    });
    video.addEventListener('pause', function () {
      if (video !== activeVideo) return;
      requested = false;
      stopPictureWatch(video);
      hideStatus();
    });
    video.addEventListener('ended', function () {
      if (video !== activeVideo) return;
      requested = false;
      stopPictureWatch(video);
      hideStatus();
      deferWarm();
    });
    video.addEventListener('progress', function () { if (video === activeVideo) deferWarm(); });
    video.addEventListener('timeupdate', function () {
      if (video === activeVideo && enoughBuffer() && !job) {
        if (!scheduleTimer) scheduleTimer = window.setTimeout(function () {
          scheduleTimer = null;
          scheduleWarm();
        }, 1200);
      }
    });
    video.addEventListener('error', function () { if (video === activeVideo) showFailure(); });
    const source = video.querySelector('source');
    if (source) source.addEventListener('error', function () {
      if (video === activeVideo) showFailure();
    });
    video.addEventListener('loadedmetadata', function () {
      if (video !== activeVideo || resumeAt <= 0 || !Number.isFinite(video.duration)) return;
      video.currentTime = Math.min(resumeAt, Math.max(0, video.duration - 0.1));
      resumeAt = 0;
    });
  }

  function makeVideo(topic) {
    const video = document.createElement('video');
    video.id = 'trainingVideo';
    video.controls = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('aria-label', topic.title + ' video');
    bindVideo(video);
    video.src = topic.media;
    return video;
  }

  function showPreview(topic) {
    const button = document.createElement('button');
    button.className = 'video-preview';
    button.id = 'videoPreview';
    button.type = 'button';
    button.setAttribute('aria-label', 'Play ' + topic.title + ' video');
    if (topic.cover) {
      const image = document.createElement('img');
      image.src = topic.cover;
      image.alt = '';
      button.appendChild(image);
    }
    const icon = document.createElement('span');
    icon.textContent = '▶';
    icon.setAttribute('aria-hidden', 'true');
    button.appendChild(icon);
    button.addEventListener('click', play);
    stage.appendChild(button);
    preview = button;
  }

  function switchTopic(topic, autoplay, pushHistory) {
    if (!topic || !topic.media || !stage) return;
    if (topic === activeTopic) {
      if (autoplay && activeVideo.paused) play();
      return;
    }
    cancelWarm();
    stopPictureWatch(activeVideo);
    window.clearTimeout(loadingTimer);
    const previous = activeVideo;
    activeVideo = null;
    previous.pause();
    previous.removeAttribute('src');
    previous.querySelectorAll('source').forEach(function (source) { source.remove(); });
    previous.load();
    previous.remove();
    if (preview) { preview.remove(); preview = null; }
    const prepared = standby && standby.topic === topic ? standby.video : null;
    if (prepared) {
      standby = null;
      prepared.hidden = false;
      prepared.removeAttribute('aria-hidden');
      prepared.id = 'trainingVideo';
      activeVideo = prepared;
    } else {
      discardStandby();
      activeVideo = makeVideo(topic);
      stage.appendChild(activeVideo);
    }
    activeTopic = topic;
    intent = null;
    failed = false;
    pictureIssue = false;
    requested = false;
    resumeAt = 0;
    document.title = 'VoxIN EVO T4 | ' + topic.title;
    document.querySelector('.video-title').textContent = topic.title;
    direct.href = topic.media;
    directory.querySelectorAll('a.video-link').forEach(function (link) {
      if (topicAt(link.href) === topic) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (pushHistory) history.pushState({ voxin: true }, '', topic.page);
    hideStatus();
    // Playback stays in this click handler, including on mobile browsers.
    if (autoplay) play();
    else showPreview(topic);
    cachePage(topic.page);
  }

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register(new URL('sw.js', root).href, {
      scope: root.pathname, updateViaCache: 'none'
    }).then(function (value) {
      registration = value;
      worker = navigator.serviceWorker.controller;
      return navigator.serviceWorker.ready;
    }).then(function () {
      worker = navigator.serviceWorker.controller || registration.active;
      cachePage(location.href);
      deferWarm();
    }).catch(function () {});
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      worker = navigator.serviceWorker.controller;
      cachePage(location.href);
      deferWarm();
    });
  }

  if (!stage || !activeVideo || !activeTopic) return;
  history.replaceState({ voxin: true }, '', location.href);
  bindVideo(activeVideo);
  direct.href = activeTopic.media;
  if (preview) {
    preview.hidden = false;
    preview.addEventListener('click', play);
  }
  if (activeVideo.error) showFailure();
  retry.addEventListener('click', function () {
    cancelWarm();
    stopPictureWatch(activeVideo);
    removePreview();
    resumeAt = Number.isFinite(activeVideo.currentTime) ? activeVideo.currentTime : 0;
    failed = false;
    pictureIssue = false;
    requested = true;
    activeVideo.load();
    play();
  });
  directory.addEventListener('click', function (event) {
    const link = event.target.closest('a.video-link');
    if (!link || event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
        link.target || link.hasAttribute('download')) return;
    const topic = topicAt(link.href);
    if (!topic || !topic.media) return;
    event.preventDefault();
    switchTopic(topic, true, true);
  });
  function noteIntent(event) {
    const link = event.target.closest('a.video-link');
    const topic = link && topicAt(link.href);
    if (!topic || topic === activeTopic || !backgroundAllowed() || !enoughBuffer()) return;
    if (intent !== topic) {
      cancelWarm();
      intent = topic;
    }
    deferWarm();
  }
  directory.addEventListener('pointerover', noteIntent);
  directory.addEventListener('focusin', noteIntent);
  directory.addEventListener('touchstart', noteIntent, { passive: true });
  window.addEventListener('popstate', function () { switchTopic(topicAt(location.href), false, false); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      cancelWarm();
      discardStandby();
    }
    else deferWarm();
  });
})();
