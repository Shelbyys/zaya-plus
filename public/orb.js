class JarvisOrb {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;

    this.state = 'idle'; // idle, listening, processing, speaking
    this.time = 0;
    this.audioLevel = 0;
    this.targetAudioLevel = 0;
    this.particles = [];
    this.rings = [];

    this.colors = {
      idle:       { primary: [0, 195, 255], secondary: [0, 255, 149], glow: [0, 195, 255] },
      listening:  { primary: [255, 68, 68],  secondary: [255, 150, 50], glow: [255, 68, 68] },
      processing: { primary: [255, 200, 50], secondary: [255, 140, 0],  glow: [255, 200, 50] },
      speaking:   { primary: [0, 255, 149],  secondary: [0, 195, 255],  glow: [0, 255, 149] },
    };

    this.currentColor = { ...this.colors.idle };
    this.resize();
    this.initParticles();
    this.initRings();
    this.animate();

    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.scale(this.dpr, this.dpr);
    this.w = rect.width;
    this.h = rect.height;
    this.cx = this.w / 2;
    this.cy = this.h / 2;
  }

  initParticles() {
    this.particles = [];
    for (let i = 0; i < 80; i++) {
      this.particles.push({
        angle: Math.random() * Math.PI * 2,
        radius: 60 + Math.random() * 60,
        speed: 0.002 + Math.random() * 0.008,
        size: 0.5 + Math.random() * 2,
        opacity: 0.2 + Math.random() * 0.6,
        offset: Math.random() * Math.PI * 2,
        wobble: Math.random() * 10,
      });
    }
  }

  initRings() {
    this.rings = [];
    for (let i = 0; i < 3; i++) {
      this.rings.push({
        radius: 80 + i * 20,
        rotation: 0,
        speed: 0.003 + i * 0.002,
        dashOffset: 0,
        opacity: 0.15 - i * 0.03,
      });
    }
  }

  setState(state) {
    this.state = state;
  }

  setAudioLevel(level) {
    this.targetAudioLevel = level;
  }

  lerpColor(a, b, t) {
    return a.map((v, i) => Math.round(v + (b[i] - v) * t));
  }

  animate() {
    this.time += 0.016;
    this.audioLevel += (this.targetAudioLevel - this.audioLevel) * 0.15;

    // Smooth color transition
    const target = this.colors[this.state];
    const t = 0.06;
    this.currentColor.primary = this.lerpColor(this.currentColor.primary, target.primary, t);
    this.currentColor.secondary = this.lerpColor(this.currentColor.secondary, target.secondary, t);
    this.currentColor.glow = this.lerpColor(this.currentColor.glow, target.glow, t);

    this.draw();
    requestAnimationFrame(() => this.animate());
  }

  draw() {
    const { ctx, cx, cy, w, h } = this;
    ctx.clearRect(0, 0, w, h);

    this.drawGlow();
    this.drawRings();
    this.drawOrb();
    this.drawParticles();
    this.drawInnerDetails();
  }

  drawGlow() {
    const { ctx, cx, cy } = this;
    const [r, g, b] = this.currentColor.glow;
    const intensity = this.state === 'idle' ? 0.08 : 0.15;
    const pulseSize = this.state === 'speaking'
      ? 120 + this.audioLevel * 40
      : 120 + Math.sin(this.time * 2) * 10;

    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, pulseSize);
    gradient.addColorStop(0, `rgba(${r},${g},${b},${intensity + 0.05})`);
    gradient.addColorStop(0.5, `rgba(${r},${g},${b},${intensity})`);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  drawOrb() {
    const { ctx, cx, cy } = this;
    const [r, g, b] = this.currentColor.primary;
    const [r2, g2, b2] = this.currentColor.secondary;

    // Base radius with audio reactivity
    let baseRadius = 50;
    if (this.state === 'speaking') {
      baseRadius += this.audioLevel * 15;
    } else if (this.state === 'listening') {
      baseRadius += Math.sin(this.time * 4) * 5;
    } else if (this.state === 'processing') {
      baseRadius += Math.sin(this.time * 6) * 3;
    }

    // Draw distorted sphere using overlapping circles
    const layers = 5;
    for (let i = layers; i >= 0; i--) {
      const layerT = i / layers;
      const radius = baseRadius * (0.6 + layerT * 0.4);
      const opacity = 0.05 + layerT * 0.12;

      // Organic distortion
      const distortX = Math.sin(this.time * 1.5 + i) * 2;
      const distortY = Math.cos(this.time * 1.8 + i) * 2;

      const gradient = ctx.createRadialGradient(
        cx + distortX - 10, cy + distortY - 10, 0,
        cx + distortX, cy + distortY, radius
      );

      const cr = Math.round(r + (r2 - r) * layerT);
      const cg = Math.round(g + (g2 - g) * layerT);
      const cb = Math.round(b + (b2 - b) * layerT);

      gradient.addColorStop(0, `rgba(${cr},${cg},${cb},${opacity + 0.15})`);
      gradient.addColorStop(0.7, `rgba(${cr},${cg},${cb},${opacity})`);
      gradient.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);

      ctx.beginPath();
      ctx.arc(cx + distortX, cy + distortY, radius, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    // Core bright center
    const coreGrad = ctx.createRadialGradient(cx - 5, cy - 5, 0, cx, cy, 20);
    coreGrad.addColorStop(0, `rgba(255,255,255,0.4)`);
    coreGrad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.beginPath();
    ctx.arc(cx, cy, 20, 0, Math.PI * 2);
    ctx.fillStyle = coreGrad;
    ctx.fill();
  }

  drawParticles() {
    const { ctx, cx, cy } = this;
    const [r, g, b] = this.currentColor.primary;

    const speedMultiplier = {
      idle: 1,
      listening: 2,
      processing: 4,
      speaking: 1.5 + this.audioLevel * 3,
    }[this.state];

    this.particles.forEach(p => {
      p.angle += p.speed * speedMultiplier;

      const wobble = Math.sin(this.time * 2 + p.offset) * p.wobble;
      const currentRadius = p.radius + wobble +
        (this.state === 'speaking' ? this.audioLevel * 20 : 0);

      const x = cx + Math.cos(p.angle) * currentRadius;
      const y = cy + Math.sin(p.angle) * currentRadius;

      const sizeBoost = this.state === 'processing' ? 1.5 : 1;
      const size = p.size * sizeBoost;

      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},${p.opacity})`;
      ctx.fill();

      // Particle trail
      if (this.state === 'processing' || this.state === 'speaking') {
        const trailX = cx + Math.cos(p.angle - 0.1) * currentRadius;
        const trailY = cy + Math.sin(p.angle - 0.1) * currentRadius;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(trailX, trailY);
        ctx.strokeStyle = `rgba(${r},${g},${b},${p.opacity * 0.3})`;
        ctx.lineWidth = size * 0.5;
        ctx.stroke();
      }
    });
  }

  drawRings() {
    const { ctx, cx, cy } = this;
    const [r, g, b] = this.currentColor.secondary;

    const speedMultiplier = this.state === 'processing' ? 3 : 1;

    this.rings.forEach((ring, i) => {
      ring.rotation += ring.speed * speedMultiplier;
      ring.dashOffset += 0.5 * speedMultiplier;

      const audioExpand = this.state === 'speaking' ? this.audioLevel * 15 : 0;
      const breathe = Math.sin(this.time * 1.2 + i * 0.8) * 5;
      const radius = ring.radius + audioExpand + breathe;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ring.rotation * (i % 2 === 0 ? 1 : -1));

      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${r},${g},${b},${ring.opacity})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([8, 12 + i * 4]);
      ctx.lineDashOffset = ring.dashOffset;
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.restore();
    });
  }

  drawInnerDetails() {
    const { ctx, cx, cy } = this;
    const [r, g, b] = this.currentColor.primary;

    // Scanning line (processing state)
    if (this.state === 'processing') {
      const scanY = cy + Math.sin(this.time * 3) * 40;
      const scanGrad = ctx.createLinearGradient(cx - 50, 0, cx + 50, 0);
      scanGrad.addColorStop(0, 'rgba(255,200,50,0)');
      scanGrad.addColorStop(0.5, 'rgba(255,200,50,0.3)');
      scanGrad.addColorStop(1, 'rgba(255,200,50,0)');
      ctx.fillStyle = scanGrad;
      ctx.fillRect(cx - 50, scanY - 1, 100, 2);
    }

    // Audio waveform inside orb (speaking state)
    if (this.state === 'speaking' && this.audioLevel > 0.05) {
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${r},${g},${b},0.3)`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 40; i++) {
        const x = cx - 20 + (i / 40) * 40;
        const amp = this.audioLevel * 15 * Math.sin(i * 0.5 + this.time * 10);
        const y = cy + amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
}

window.JarvisOrb = JarvisOrb;
