'use strict';

/**
 * Data-driven pixel office renderer.
 *
 * The Claude Design export is a behavioral/art-direction reference, not a
 * production dependency. This implementation redraws the scene from primitives
 * and accepts only the small, trusted view model assembled by renderer.js.
 */
(function installPixelOffice() {
  const SCALE = 2;
  const LOGICAL_WIDTH = 624;
  const LOGICAL_HEIGHT = 285;
  const DISPLAY_WIDTH = LOGICAL_WIDTH * SCALE;
  const DISPLAY_HEIGHT = LOGICAL_HEIGHT * SCALE;
  const DESKS = [
    [36, 116],
    [164, 116],
    [292, 116],
    [100, 196],
    [228, 196],
  ];
  const COUNCIL_SEATS = [
    [424, 196],
    [544, 196],
    [458, 238],
    [490, 242],
    [522, 238],
  ];
  const HAIR_COLORS = ['#3b2a20', '#202129', '#743820', '#c3a047', '#bfc3c8', '#37273f'];

  function hash(value) {
    let result = 2166136261;
    for (const character of value) {
      result ^= character.charCodeAt(0);
      result = Math.imul(result, 16777619);
    }
    return result >>> 0;
  }

  function shortLabel(value) {
    const compact = value.replace(/\s+/g, ' ').trim().toUpperCase();
    return compact.length > 13 ? `${compact.slice(0, 12)}…` : compact;
  }

  function create(canvas, callbacks = {}) {
    const context = canvas.getContext('2d', { alpha: false });

    let scene = {
      agents: [],
      connected: false,
      stale: false,
      page: 1,
      pages: 1,
    };
    let tick = 0;
    let hitboxes = [];

    function ensureBackingStore() {
      const deviceScale = Math.max(1, window.devicePixelRatio || 1);
      const expectedWidth = Math.round(DISPLAY_WIDTH * deviceScale);
      const expectedHeight = Math.round(DISPLAY_HEIGHT * deviceScale);
      if (canvas.width !== expectedWidth || canvas.height !== expectedHeight) {
        canvas.width = expectedWidth;
        canvas.height = expectedHeight;
      }
      context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
      context.imageSmoothingEnabled = false;
    }

    const pixel = (x, y, width, height, color) => {
      context.fillStyle = color;
      context.fillRect(
        Math.round(x * SCALE),
        Math.round(y * SCALE),
        Math.round(width * SCALE),
        Math.round(height * SCALE),
      );
    };

    const shadow = (x, y, width, height, alpha = 0.22) => {
      pixel(x, y, width, height, `rgba(12,10,18,${alpha})`);
    };

    const light = (x, y, width, height, alpha = 0.25) => {
      pixel(x, y, width, height, `rgba(255,248,230,${alpha})`);
    };

    function label(text, x, y, color = '#dce4eb', size = 8, align = 'center') {
      context.save();
      context.imageSmoothingEnabled = false;
      context.font = `600 ${size}px "Cascadia Mono", Consolas, monospace`;
      context.textAlign = align;
      context.textBaseline = 'alphabetic';
      context.fillStyle = color;
      context.fillText(text, Math.round(x * SCALE), Math.round(y * SCALE));
      context.restore();
    }

    function bookshelf(x, y, width) {
      shadow(x + 1, y + 26, width, 3);
      pixel(x, y, width, 26, '#6e4522');
      pixel(x, y, width, 3, '#8a5a30');
      pixel(x + 2, y + 4, width - 4, 8, '#3e2712');
      pixel(x + 2, y + 15, width - 4, 8, '#3e2712');
      const bookColors = ['#c25b4a', '#4a8ac2', '#5aa46a', '#c2a24a', '#8a5ac2', '#c27b4a'];
      for (let index = 0; index < Math.floor((width - 8) / 5); index += 1) {
        const top = bookColors[index % bookColors.length];
        const bottom = bookColors[(index + 3) % bookColors.length];
        pixel(x + 4 + index * 5, y + 5, 4, 7, top);
        light(x + 4 + index * 5, y + 5, 1, 7);
        pixel(x + 4 + index * 5, y + 16, 4, 7, bottom);
        light(x + 4 + index * 5, y + 16, 1, 7);
      }
    }

    function plant(x, y) {
      shadow(x + 2, y + 19, 12, 3);
      pixel(x + 4, y + 12, 8, 8, '#8a4e2a');
      pixel(x + 4, y + 12, 8, 2, '#a9683c');
      pixel(x, y, 16, 12, '#3e7a46');
      pixel(x + 2, y + 1, 6, 4, '#57a05e');
      pixel(x + 10, y + 4, 4, 3, '#57a05e');
      pixel(x + 6, y - 3, 4, 4, '#3e7a46');
    }

    function chair(x, y) {
      shadow(x + 1, y + 24, 26, 3);
      pixel(x, y, 26, 24, '#906979');
      pixel(x + 2, y + 2, 22, 14, '#b7899a');
      pixel(x, y + 18, 26, 6, '#7e5666');
      pixel(x - 2, y + 4, 4, 18, '#7e5666');
      pixel(x + 24, y + 4, 4, 18, '#7e5666');
    }

    function drawCharacter(x, y, agent, pose) {
      const style = hash(agent.key) % 4;
      const hair = HAIR_COLORS[hash(agent.key) % HAIR_COLORS.length];
      const skin = '#e7b889';
      const skinShade = '#ca9068';
      const shirt = agent.color;
      const armLift = pose === 'typing-a' ? -1 : 0;

      shadow(x + 1, y + 24, 16, 3);

      if (style === 0) {
        pixel(x + 2, y, 12, 4, hair);
        pixel(x, y + 3, 16, 4, hair);
      } else if (style === 1) {
        pixel(x + 1, y + 1, 14, 5, hair);
        pixel(x + 2, y - 2, 3, 4, hair);
        pixel(x + 7, y - 3, 3, 5, hair);
        pixel(x + 12, y - 2, 3, 4, hair);
      } else if (style === 2) {
        pixel(x, y + 1, 16, 6, hair);
        pixel(x - 1, y + 5, 3, 11, hair);
        pixel(x + 14, y + 5, 3, 11, hair);
      } else {
        pixel(x + 1, y, 14, 6, hair);
        pixel(x + 3, y - 1, 4, 2, '#ece1c7');
        pixel(x + 9, y - 1, 4, 2, '#ece1c7');
      }

      pixel(x + 2, y + 5, 12, 7, skin);
      pixel(x + 2, y + 11, 12, 2, skinShade);
      if (pose === 'sleeping') {
        pixel(x + 4, y + 8, 3, 1, '#765c4b');
        pixel(x + 10, y + 8, 3, 1, '#765c4b');
      } else {
        pixel(x + 4, y + 7, 2, 2, '#f4f4ef');
        pixel(x + 10, y + 7, 2, 2, '#f4f4ef');
        pixel(x + 5, y + 8, 1, 1, '#202129');
        pixel(x + 11, y + 8, 1, 1, '#202129');
      }
      pixel(x + 7, y + 11, 3, 1, '#98684c');

      pixel(x + 1, y + 13, 14, 9, shirt);
      light(x + 2, y + 14, 2, 7, 0.23);
      shadow(x + 12, y + 13, 3, 9, 0.22);
      pixel(x - 2, y + 15 + armLift, 3, 7, shirt);
      pixel(x + 15, y + 15 - armLift, 3, 7, shirt);
      pixel(x - 2, y + 21 + armLift, 3, 2, skin);
      pixel(x + 15, y + 21 - armLift, 3, 2, skin);

      if (pose === 'standing') {
        pixel(x + 3, y + 22, 4, 7, '#34404c');
        pixel(x + 9, y + 22, 4, 7, '#34404c');
        pixel(x + 3, y + 28, 4, 2, '#1d2228');
        pixel(x + 9, y + 28, 4, 2, '#1d2228');
      }
    }

    function drawStatusBubble(x, y, symbol, color) {
      pixel(x, y, 16, 14, '#22272e');
      pixel(x + 1, y + 1, 14, 11, '#f5f2e8');
      pixel(x + 5, y + 12, 4, 3, '#f5f2e8');
      label(symbol, x + 8, y + 10, color, 9);
    }

    function drawRoom() {
      pixel(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT, '#0b0e13');

      // Wood office, tiled diagnostics lab, and blue Council room.
      pixel(8, 30, 368, 246, '#a8763f');
      for (let y = 30; y < 276; y += 16) pixel(8, y, 368, 8, '#a2703b');
      for (let y = 38; y < 276; y += 8) pixel(8, y, 368, 1, '#8f6434');
      for (let index = 0; index < 170; index += 1) {
        pixel(
          10 + ((index * 29) % 362),
          30 + ((index * 41) % 244),
          1,
          1,
          index % 2 ? '#b07e48' : '#8f6434',
        );
      }

      for (let tileX = 386; tileX < 614; tileX += 12) {
        for (let tileY = 30; tileY < 128; tileY += 12) {
          pixel(tileX, tileY, 12, 12, (tileX + tileY) / 12 % 2 ? '#eadfcc' : '#dfd3bd');
        }
      }

      pixel(386, 140, 228, 136, '#4a7290');
      for (let x = 398; x < 614; x += 12) pixel(x, 140, 1, 136, '#426884');
      for (let y = 152; y < 276; y += 12) pixel(386, y, 228, 1, '#426884');
      pixel(438, 188, 128, 72, '#3e5e78');
      pixel(438, 188, 128, 3, '#5b84a6');
      pixel(438, 257, 128, 3, '#5b84a6');

      // Outer and dividing walls.
      pixel(6, 6, 612, 24, '#313d58');
      pixel(6, 6, 612, 5, '#1a2130');
      pixel(6, 27, 612, 3, '#232b3a');
      pixel(6, 6, 6, 270, '#1a2130');
      pixel(612, 6, 6, 270, '#1a2130');
      pixel(6, 270, 612, 6, '#1a2130');
      pixel(376, 6, 10, 270, '#1a2130');
      pixel(386, 128, 228, 12, '#1a2130');
      pixel(450, 128, 36, 12, '#426884');
      pixel(377, 60, 8, 32, '#d8ccb6');
      pixel(377, 196, 8, 32, '#8a6a44');
      shadow(8, 30, 368, 3, 0.28);
      shadow(386, 30, 228, 3, 0.28);
      shadow(386, 140, 228, 3, 0.28);

      // Room signage.
      pixel(400, 10, 92, 14, '#232b3a');
      pixel(402, 12, 88, 10, '#151a1f');
      label('DIAGNOSTICS', 446, 20, scene.connected ? '#45b39a' : '#d96a5f', 7);
      pixel(500, 10, 104, 14, '#232b3a');
      pixel(502, 12, 100, 10, '#151a1f');
      label(`OFFICE ${scene.page}/${scene.pages}`, 552, 20, '#aeb8c2', 7);

      // Office fixtures.
      bookshelf(20, 34, 56);
      bookshelf(84, 34, 56);
      bookshelf(220, 34, 56);
      bookshelf(284, 34, 56);
      plant(16, 244);
      plant(350, 38);
      pixel(148, 42, 24, 14, '#c9a15e');
      pixel(148, 42, 24, 3, '#a9803e');
      pixel(158, 32, 18, 11, '#b89050');
      pixel(158, 32, 18, 3, '#98713a');

      // Server rack.
      shadow(19, 212, 28, 3);
      pixel(18, 170, 28, 44, '#23272e');
      pixel(18, 170, 28, 3, '#3a4148');
      for (let row = 0; row < 3; row += 1) {
        pixel(21, 175 + row * 10, 22, 8, '#14181e');
        pixel(23, 177 + row * 10, 3, 2, tick ? '#5ac46a' : '#2e5e36');
        pixel(28, 177 + row * 10, 3, 2, row === 2 ? '#c25b4a' : '#e8a33d');
      }

      // Diagnostics equipment.
      shadow(395, 74, 24, 3);
      pixel(394, 36, 24, 40, '#3a5e86');
      pixel(397, 41, 18, 20, '#9fc6e8');
      pixel(399, 43, 6, 6, '#c25b4a');
      pixel(407, 43, 6, 6, '#c2a24a');
      pixel(399, 51, 6, 6, '#5aa46a');
      pixel(407, 51, 6, 6, '#8a5ac2');
      pixel(397, 64, 18, 6, '#1e2a38');
      pixel(428, 48, 14, 20, '#e2dcd0');
      pixel(430, 38, 10, 12, '#b8d8e8');
      pixel(470, 40, 80, 18, '#d9d2c6');
      pixel(470, 40, 80, 3, '#eae4d8');
      pixel(572, 34, 28, 46, '#c9cdd4');
      pixel(572, 52, 28, 2, '#9aa0aa');
      pixel(575, 44, 2, 6, '#8a9098');
      pixel(575, 58, 2, 8, '#8a9098');
      label(scene.stale ? 'STATE STALE' : scene.connected ? 'RUNTIME ONLINE' : 'RUNTIME OFFLINE', 500, 112, scene.stale ? '#e8a33d' : scene.connected ? '#2f6b5e' : '#9a433d', 7);

      // Council room equipment.
      pixel(394, 144, 48, 30, '#14181e');
      pixel(396, 146, 44, 26, '#1e3a56');
      pixel(396, 146, 44, 10, tick ? '#4a7eb4' : '#40709f');
      pixel(396, 162, 44, 10, '#2e5e46');
      bookshelf(548, 142, 52);
      pixel(472, 142, 34, 24, '#8a5a30');
      pixel(474, 144, 30, 20, '#4a2e16');
      pixel(476, 146, 26, 16, '#9fc6e8');
      pixel(476, 155, 26, 7, '#5aa46a');
      plant(392, 248);
      plant(592, 248);
      shadow(475, 229, 56, 3);
      pixel(474, 208, 56, 22, '#9a6a36');
      pixel(474, 208, 56, 3, '#b07e44');
      pixel(474, 227, 56, 3, '#7a4e22');
      pixel(482, 212, 14, 3, '#d9d2c6');
      pixel(482, 206, 14, 8, '#2a2f38');
      pixel(483, 207, 12, 6, '#4a8ac2');
      pixel(512, 212, 9, 11, '#e8e2d4');
      label('COUNCIL ROOM', 500, 184, '#bfd3e2', 7);

      hitboxes.push(
        { type: 'room', id: 'diagnostics', x: 386 * SCALE, y: 30 * SCALE, width: 228 * SCALE, height: 98 * SCALE },
        { type: 'room', id: 'council', x: 386 * SCALE, y: 140 * SCALE, width: 228 * SCALE, height: 136 * SCALE },
      );
    }

    function drawDesk(agent, index) {
      const [x, y] = DESKS[index];
      const active = agent && ['working', 'blocked', 'failed'].includes(agent.mode);
      const screenColor =
        agent?.mode === 'blocked'
          ? '#6a491d'
          : agent?.mode === 'failed'
            ? '#5e2525'
            : active
              ? '#10151c'
              : '#232a33';

      pixel(x + 20, y - 28, 24, 8, '#3a4148');
      pixel(x + 22, y - 24, 20, 20, '#4a525c');
      if (active) {
        drawCharacter(
          x + 24,
          y - 22,
          agent,
          agent.mode === 'working' && (tick + index) % 2 ? 'typing-a' : 'typing-b',
        );
      }

      shadow(x + 2, y + 30, 62, 4);
      pixel(x, y, 64, 24, '#96642f');
      pixel(x, y, 64, 3, '#a9743c');
      pixel(x, y + 8, 64, 1, '#88571f');
      pixel(x, y + 16, 64, 1, '#88571f');
      pixel(x, y + 24, 64, 6, '#7a4e22');
      pixel(x + 20, y + 2, 24, 15, '#1a1f26');
      pixel(x + 22, y + 4, 20, 11, screenColor);

      if (active) {
        const codeColor =
          agent.mode === 'blocked' ? '#e8a33d' : agent.mode === 'failed' ? '#d96a5f' : agent.color;
        for (let row = 0; row < 4; row += 1) {
          pixel(x + 23, y + 5 + row * 2, [13, 9, 15, 7][(row + tick) % 4], 1, codeColor);
        }
        light(x + 23, y + 5 + (tick % 4) * 2, 3, 1, 0.55);
      }

      pixel(x + 3, y + 15, 20, 8, '#39424e');
      pixel(x + 5, y + 16, 16, 6, '#d9d2c6');
      pixel(x + 52, y + 8, 7, 8, agent?.color ?? '#5e6873');
      light(x + 52, y + 8, 7, 2, 0.3);
      pixel(x + 4, y + 4, 11, 8, '#e8e2d4');
      pixel(x + 5, y + 6, 9, 1, '#b8b0a2');
      pixel(x + 5, y + 9, 9, 1, '#b8b0a2');

      if (agent?.mode === 'blocked' && tick) drawStatusBubble(x + 39, y - 45, '!', '#e8a33d');
      if (agent?.mode === 'failed' && tick) drawStatusBubble(x + 39, y - 45, '×', '#d96a5f');

      const textColor =
        agent?.mode === 'blocked'
          ? '#e8a33d'
          : agent?.mode === 'failed'
            ? '#d96a5f'
            : active
              ? '#f2efe8'
              : '#6b7682';
      label(agent ? shortLabel(agent.label) : 'OPEN STATION', x + 32, y + 42, textColor, 7);
      if (agent?.missionBadge) {
        pixel(x + 2, y + 45, 60, 9, '#14282b');
        pixel(x + 2, y + 45, 60, 1, '#64bfc2');
        label(
          shortLabel(agent.missionBadge.label),
          x + 32,
          y + 52,
          '#7bd4d0',
          6,
        );
      }

      if (agent) {
        hitboxes.push({
          type: 'agent',
          id: agent.key,
          x: x * SCALE,
          y: (y - 46) * SCALE,
          width: 64 * SCALE,
          height: 100 * SCALE,
        });
      }
    }

    function drawCouncilAgents(agents) {
      agents.forEach((agent, index) => {
        const [seatX, seatY] = COUNCIL_SEATS[index];
        if (index < 2) chair(seatX, seatY);
        const sleeping = agent.mode === 'cold' || agent.mode === 'stopped';
        drawCharacter(seatX + 5, seatY + 1, agent, sleeping ? 'sleeping' : 'standing');
        if (sleeping && tick) label('Z', seatX + 24, seatY - 3, '#bfd3e2', 8);
        if (agent.mode === 'done') label('✓', seatX + 24, seatY - 3, '#45b39a', 9);
        label(shortLabel(agent.label), seatX + 13, seatY + 35, '#bfd3e2', 7);
        hitboxes.push({
          type: 'agent',
          id: agent.key,
          x: (seatX - 2) * SCALE,
          y: (seatY - 8) * SCALE,
          width: 30 * SCALE,
          height: 46 * SCALE,
        });
      });
    }

    function draw() {
      ensureBackingStore();
      hitboxes = [];
      drawRoom();

      for (let index = 0; index < DESKS.length; index += 1) {
        drawDesk(scene.agents[index], index);
      }

      drawCouncilAgents(
        scene.agents.filter(
          (agent) =>
            agent.mode !== 'missing' &&
            !['working', 'blocked', 'failed'].includes(agent.mode),
        ),
      );

      // Ambient light and bottom-edge shadow.
      const glow = context.createRadialGradient(240, 280, 10, 240, 280, 220);
      glow.addColorStop(0, 'rgba(255,214,130,.09)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = glow;
      context.fillRect(20, 80, 440, 400);
      shadow(8, 258, 368, 18, 0.1);
      shadow(386, 258, 228, 18, 0.1);
    }

    function handleClick(event) {
      const bounds = canvas.getBoundingClientRect();
      const x = (event.clientX - bounds.left) * (DISPLAY_WIDTH / bounds.width);
      const y = (event.clientY - bounds.top) * (DISPLAY_HEIGHT / bounds.height);
      // Agents take precedence when their sprite overlaps a room hotspot.
      const target =
        hitboxes.find(
          (entry) =>
            entry.type === 'agent' &&
            x >= entry.x &&
            x <= entry.x + entry.width &&
            y >= entry.y &&
            y <= entry.y + entry.height,
        ) ??
        hitboxes.find(
          (entry) =>
            x >= entry.x &&
            x <= entry.x + entry.width &&
            y >= entry.y &&
            y <= entry.y + entry.height,
        );
      if (target?.type === 'agent') callbacks.onAgentSelected?.(target.id);
      if (target?.type === 'room') callbacks.onRoomSelected?.(target.id);
    }

    canvas.addEventListener('click', handleClick);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setInterval(() => {
      if (document.hidden || reducedMotion) return;
      tick = tick === 0 ? 1 : 0;
      draw();
    }, 600);

    draw();

    return {
      setScene(nextScene) {
        scene = {
          ...scene,
          ...nextScene,
          agents: Array.isArray(nextScene.agents) ? nextScene.agents.slice(0, 5) : [],
        };
        draw();
      },
      destroy() {
        window.clearInterval(timer);
        canvas.removeEventListener('click', handleClick);
      },
    };
  }

  window.CouncilPixelOffice = { create };
})();
