(function () {
  const SOCKET_URL = (window.CHAT_MIDDLEWARE_URL || 'http://localhost:3001').replace(/\/$/, '');
  const HEARTBEAT_INTERVAL = 30_000;
  const STORAGE_KEY = 'n8n-chat-session';

  function loadPersistedSession() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (error) {
      console.warn('Unable to read chat session from storage', error);
      return {};
    }
  }

  function persistSession(session) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch (error) {
      console.warn('Unable to persist chat session', error);
    }
  }

  function loadSocketIo(callback) {
    if (window.io) {
      callback();
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
    script.async = true;
    script.onload = callback;
    script.onerror = () => console.error('Failed to load Socket.IO client');
    document.head.appendChild(script);
  }

  function createUi() {
    const container = document.createElement('div');
    container.id = 'n8n-chat-widget';
    container.innerHTML = `
      <style>
        #n8n-chat-widget { position: fixed; bottom: 16px; right: 16px; width: 320px; font-family: sans-serif; z-index: 9999; }
        #n8n-chat-widget .chat-card { background: #fff; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); display: flex; flex-direction: column; overflow: hidden; }
        #n8n-chat-widget header { background: #111827; color: #fff; padding: 12px 16px; font-weight: bold; }
        #n8n-chat-widget ul { list-style: none; margin: 0; padding: 12px; height: 280px; overflow-y: auto; }
        #n8n-chat-widget li { margin-bottom: 12px; line-height: 1.3; }
        #n8n-chat-widget li.user { text-align: right; }
        #n8n-chat-widget li.user span { background: #4f46e5; color: #fff; }
        #n8n-chat-widget li.ai span { background: #f3f4f6; color: #111827; }
        #n8n-chat-widget li span { display: inline-block; padding: 8px 12px; border-radius: 12px; }
        #n8n-chat-widget form { display: flex; gap: 8px; border-top: 1px solid #e5e7eb; padding: 12px; background: #fff; }
        #n8n-chat-widget input { flex: 1; border: 1px solid #d1d5db; border-radius: 9999px; padding: 8px 14px; }
        #n8n-chat-widget button { background: #111827; color: #fff; border: none; border-radius: 9999px; padding: 8px 16px; cursor: pointer; }
      </style>
      <div class="chat-card">
        <header>Ask our AI Assistant</header>
        <ul class="messages"></ul>
        <form>
          <input type="text" placeholder="Type a message..." required />
          <button type="submit">Send</button>
        </form>
      </div>
    `;

    document.body.appendChild(container);
    return container;
  }

  function init() {
    const { sessionId, visitorId } = loadPersistedSession();
    const container = createUi();
    const messageList = container.querySelector('ul.messages');
    const form = container.querySelector('form');
    const input = container.querySelector('input');

    const socket = window.io(SOCKET_URL, {
      transports: ['websocket'],
      auth: { sessionId, visitorId },
    });

    let currentSessionId = sessionId;
    let heartbeatHandle = null;

    function appendMessage(sender, content) {
      const li = document.createElement('li');
      li.className = sender === 'USER' ? 'user' : 'ai';
      const bubble = document.createElement('span');
      bubble.textContent = content;
      li.appendChild(bubble);
      messageList.appendChild(li);
      messageList.scrollTop = messageList.scrollHeight;
    }

    socket.on('session', (payload) => {
      currentSessionId = payload.sessionId;
      persistSession({ sessionId: payload.sessionId, visitorId: payload.visitorId });
    });

    socket.on('history', (history) => {
      messageList.innerHTML = '';
      history.forEach((msg) => appendMessage(msg.sender, msg.content));
    });

    socket.on('message', (msg) => appendMessage(msg.sender, msg.content));

    socket.on('error', (error) => {
      appendMessage('SYSTEM', error.message || 'Something went wrong.');
    });

    socket.on('connect_error', () => {
      appendMessage('SYSTEM', 'Unable to reach chat server.');
    });

    function sendHeartbeat() {
      if (!currentSessionId) return;
      socket.emit('heartbeat', { sessionId: currentSessionId });
    }

    heartbeatHandle = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value || !currentSessionId) return;
      socket.emit('message', {
        sessionId: currentSessionId,
        content: value,
        metadata: { page: window.location.href },
      });
      input.value = '';
    });

    window.addEventListener('beforeunload', () => {
      window.clearInterval(heartbeatHandle);
      sendHeartbeat();
    });
  }

  loadSocketIo(init);
})();
