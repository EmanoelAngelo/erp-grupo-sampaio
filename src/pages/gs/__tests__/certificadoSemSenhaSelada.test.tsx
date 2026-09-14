/**
 * ============================================================================
 * O CERTIFICADO SEM A SENHA NO COFRE, NA TELA — GAP-PRD-023
 * ============================================================================
 *
 * O A1 real da Preço Justo foi gravado antes de a senha passar a ser selada:
 * o arquivo está no cofre, a senha não. O servidor já sabia dizer o que fazer
 * ("Reenvie o arquivo com a senha em Fiscal › Certificado"), mas só na hora da
 * venda, como erro. A tela mostrava "Senha selada no cofre: não" dentro dos
 * detalhes técnicos, fechados, e a lista do grupo pintava a operação de
 * "válido". Ninguém foi instruído a fazer o reenvio.
 *
 * O que cada caso quebra sem o conserto:
 *
 *   - sem o aviso aberto, o dono só descobre na primeira venda — o primeiro
 *     caso cobra a instrução e o selo de pendência;
 *   - aviso que aparece sem motivo vira ruído — o segundo cobra o silêncio com
 *     a senha selada;
 *   - a lista do grupo sem a coluna esconde qual operação precisa do reenvio —
 *     o terceiro cobra a marca;
 *   - GAP-PRD-179: desativar agora apaga arquivo E senha, e a tela diz isso.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import CertificadoPage from '../CertificadoPage';

/** O registro do dono: gravado antes da autodetecção e antes da senha selada. */
const CERTIFICADO_ANTIGO = {
  id: 'cert-pj',
  subject: 'PRECO JUSTO COMERCIO LTDA:11222333000181',
  holderName: null,
  documentType: null,
  documentNumber: null,
  cnpj: '11222333000181',
  issuer: 'AC DIGITAL MULTIPLA G1',
  serialNumber: '0a1b2c',
  subjectDn: null,
  issuerDn: null,
  fingerprintSha256: null,
  chainLength: null,
  selfSigned: null,
  cnpjConference: null,
  cnpjConferenceWarning: null,
  validFrom: '2025-10-15T12:00:00.000Z',
  validTo: '2026-10-15T12:00:00.000Z',
  senhaGuardada: false,
};

function view(certificate: Record<string, unknown>) {
  return {
    configured: true,
    situation: 'valido',
    message: 'Certificado válido. Vence em 34 dia(s).',
    readiness: 'CERTIFICATE_LOADED',
    daysRemaining: 34,
    alerta: null,
    certificate,
  };
}

function linhaDoGrupo(senhaGuardada: boolean) {
  return {
    companyId: 'loja',
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'Preço Justo Ltda',
    configured: true,
    situation: 'valido',
    message: 'Certificado válido.',
    daysRemaining: 34,
    alerta: null,
    holderName: 'PRECO JUSTO COMERCIO LTDA:11222333000181',
    documentNumber: '11222333000181',
    issuer: 'AC DIGITAL MULTIPLA G1',
    validFrom: '2025-10-15T12:00:00.000Z',
    validTo: '2026-10-15T12:00:00.000Z',
    senhaGuardada,
  };
}

let atual: ReturnType<typeof view>;
let grupo: ReturnType<typeof linhaDoGrupo>[];

function servidor() {
  return vi.fn(async (url: string) => {
    const alvo = String(url);
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (alvo.includes('/core/fiscal/certificates/group')) return json({ items: grupo });
    if (alvo.includes('/core/fiscal/certificate')) return json(atual);
    return json({ items: [] });
  });
}

beforeEach(() => {
  atual = view(CERTIFICADO_ANTIGO);
  grupo = [linhaDoGrupo(false)];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-dono', login: 'dono', displayName: 'Dono', profileCode: 'gestor' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Preço Justo', kind: 'retail', profileCode: 'gestor' },
      ],
    } as never,
    'LOGIN',
    'teste do certificado sem senha selada',
  );
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function abrir() {
  render(
    <MemoryRouter>
      <CertificadoPage />
    </MemoryRouter>,
  );
  await screen.findByText('Número de série');
}

describe('a senha que não está no cofre', () => {
  it('o cartão diz, aberto, o que para e o que fazer — e marca a pendência', async () => {
    await abrir();

    const aviso = await screen.findByText('A senha deste certificado não está selada no cofre.');
    const bloco = aviso.closest('[role="alert"]')!;
    expect(bloco).toBeTruthy();
    expect(bloco.textContent).toMatch(/o PDV e a fila não assinam sozinhos/);
    expect(bloco.textContent).toMatch(/Reenvie o mesmo arquivo \.pfx com a senha/);
    // Não é enfeite dentro de <details>: está fora dele.
    expect(bloco.closest('details')).toBeNull();

    expect(screen.getByText('CERTIFICADO COM PENDÊNCIA')).toBeTruthy();
    expect(screen.getByText('não — reenvie o arquivo com a senha')).toBeTruthy();
    // E o gesto que resolve está na mesma tela.
    expect(screen.getByText('Substituir certificado')).toBeTruthy();
  });

  it('com a senha selada, o aviso não aparece', async () => {
    atual = view({ ...CERTIFICADO_ANTIGO, senhaGuardada: true, selfSigned: false });
    grupo = [linhaDoGrupo(true)];
    await abrir();

    expect(screen.queryByText('A senha deste certificado não está selada no cofre.')).toBeNull();
    expect(screen.getByText('CERTIFICADO VALIDADO')).toBeTruthy();
  });

  it('a lista do grupo marca a operação que precisa do reenvio', async () => {
    await abrir();

    expect(await screen.findByText('NÃO SELADA — REENVIE')).toBeTruthy();
    expect(screen.getByText(/1 precisam de atenção/)).toBeTruthy();
  });
});

describe('desativar (GAP-PRD-179)', () => {
  it('a confirmação diz que o arquivo e a senha saem do cofre', async () => {
    await abrir();

    fireEvent.click(screen.getByText('Desativar certificado'));
    expect(screen.getByText(/O arquivo e a senha selada saem\s+do cofre/)).toBeTruthy();
  });
});
