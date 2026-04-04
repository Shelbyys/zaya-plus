import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Testes de integração: sobe o servidor real e testa endpoints
// Requer que as env vars mínimas estejam presentes

let baseUrl;
let server;

beforeAll(async () => {
  // Importa e espera o servidor subir
  process.env.PORT = '3099'; // Porta de teste
  process.env.BOT_PASSWORD = 'test-pwd-123';
  process.env.NODE_ENV = 'test';

  const mod = await import('../server.js');
  baseUrl = `http://localhost:3099`;

  // Espera o servidor ficar pronto
  for (let i = 0; i < 20; i++) {
    try {
      await fetch(`${baseUrl}/api/contacts`);
      break;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
}, 15000);

afterAll(() => {
  // Force exit pois o server fica escutando
  setTimeout(() => process.exit(0), 500);
});

describe('GET /api/contacts', () => {
  it('deve retornar array', async () => {
    const res = await fetch(`${baseUrl}/api/contacts`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('deve filtrar por query', async () => {
    const res = await fetch(`${baseUrl}/api/contacts?q=zzznobody`);
    const data = await res.json();
    expect(data).toHaveLength(0);
  });
});

describe('GET /api/messages', () => {
  it('deve retornar array', async () => {
    const res = await fetch(`${baseUrl}/api/messages`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });
});

describe('POST/DELETE /api/messages', () => {
  const testMsg = {
    id: 'test_msg_' + Date.now(),
    title: 'Test Message',
    content: 'Test content',
    type: 'pesquisa',
  };

  it('deve criar mensagem', async () => {
    const res = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testMsg),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('deve encontrar a mensagem criada', async () => {
    const res = await fetch(`${baseUrl}/api/messages`);
    const data = await res.json();
    const found = data.find(m => m.id === testMsg.id);
    expect(found).toBeDefined();
    expect(found.title).toBe('Test Message');
  });

  it('deve deletar mensagem', async () => {
    const res = await fetch(`${baseUrl}/api/messages/${testMsg.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/chats', () => {
  it('deve retornar array', async () => {
    const res = await fetch(`${baseUrl}/api/chats`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });
});

describe('POST /api/exec', () => {
  it('deve executar comando seguro', async () => {
    const res = await fetch(`${baseUrl}/api/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo test123' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.output).toContain('test123');
  });

  it('deve bloquear comando perigoso', async () => {
    const res = await fetch(`${baseUrl}/api/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'rm -rf /tmp' }),
    });
    expect(res.status).toBe(403);
  });

  it('deve rejeitar comando vazio', async () => {
    const res = await fetch(`${baseUrl}/api/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: '' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/login', () => {
  it('deve rejeitar senha incorreta', async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    expect(res.status).toBe(401);
  });

  it('deve aceitar senha correta', async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-pwd-123' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.token).toBeDefined();
  });
});

describe('GET /api/whatsapp/instances', () => {
  it('deve retornar lista de instâncias', async () => {
    const res = await fetch(`${baseUrl}/api/whatsapp/instances`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('instances');
    expect(Array.isArray(data.instances)).toBe(true);
  });
});

describe('Security headers', () => {
  it('deve ter X-Content-Type-Options: nosniff', async () => {
    const res = await fetch(`${baseUrl}/api/contacts`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('deve ter X-Frame-Options', async () => {
    const res = await fetch(`${baseUrl}/api/contacts`);
    expect(res.headers.get('x-frame-options')).toBeTruthy();
  });
});
