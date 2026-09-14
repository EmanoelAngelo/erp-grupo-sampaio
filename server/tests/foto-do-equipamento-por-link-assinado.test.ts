/**
 * A FOTO DA MÁQUINA ABRE SÓ POR LINK ASSINADO — como a da OS (GAP-PRD-184,
 * na junção com o GAP-PRD-106).
 *
 * As fotos do equipamento nasceram depois do guarda da foto da OS e saíam pelo
 * `express.static` público, com cache de sete dias: o chassi, a placa e o estado
 * da moto do cliente abertos a quem tivesse o endereço. Cada caso cai quando o
 * guarda correspondente sai:
 *   - sem o guarda em `/uploads/equipamentos`, o primeiro cai (200 sem assinatura);
 *   - sem `cacheControl: false` + o cabeçalho do guarda, o segundo cai (cache público);
 *   - sem o domínio por pasta, o terceiro e o quarto caem: o link de uma foto da
 *     OS abriria o arquivo de mesmo nome na pasta das máquinas, e vice-versa.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import {
  assinarCaminhoDaFoto,
  conferirLinkDaFoto,
} from '../src/services/core/FotoDaOsAssinada.js';

let pasta: string;
let app: Express;
const nome = `${randomUUID()}.jpg`;

beforeAll(async () => {
  pasta = mkdtempSync(join(tmpdir(), 'gs-fotos-da-maquina-'));
  process.env.DEVORA_UPLOADS_DIR = pasta;
  mkdirSync(join(pasta, 'equipamentos'), { recursive: true });
  writeFileSync(join(pasta, 'equipamentos', nome), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const { createApp } = await import('../src/app.js');
  app = createApp();
});

afterAll(() => {
  delete process.env.DEVORA_UPLOADS_DIR;
  rmSync(pasta, { recursive: true, force: true });
});

function partes(link: string): { e: string; s: string } {
  const u = new URL(link, 'http://x');
  return { e: u.searchParams.get('e') ?? '', s: u.searchParams.get('s') ?? '' };
}

describe('a foto da máquina por link assinado', () => {
  it('o endereço cru não abre: 403 com a frase da ficha do equipamento', async () => {
    const res = await request(app).get(`/uploads/equipamentos/${nome}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_PHOTO_LINK_INVALID');
    expect(res.body.error.message).toContain('ficha do equipamento');
  });

  it('o link assinado abre, com cache PRIVADO que acaba junto com a validade', async () => {
    const link = assinarCaminhoDaFoto(`/uploads/equipamentos/${nome}`);
    expect(link).toMatch(/\?e=\d+&s=/);
    const res = await request(app).get(link);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/^private, max-age=\d+$/);
  });

  it('o link de uma foto da OS com o MESMO nome não abre a foto da máquina', async () => {
    const daOs = partes(assinarCaminhoDaFoto(`/uploads/os/${nome}`));
    const res = await request(app).get(`/uploads/equipamentos/${nome}?e=${daOs.e}&s=${daOs.s}`);
    expect(res.status).toBe(403);
  });

  it('e o link da máquina não vale como link de foto da OS', () => {
    const daMaquina = partes(assinarCaminhoDaFoto(`/uploads/equipamentos/${nome}`));
    expect(conferirLinkDaFoto(nome, daMaquina.e, daMaquina.s, Date.now(), 'os').ok).toBe(false);
    expect(conferirLinkDaFoto(nome, daMaquina.e, daMaquina.s, Date.now(), 'equipamentos').ok).toBe(true);
  });
});
