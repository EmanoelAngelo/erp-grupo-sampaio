/**
 * DUBLÊ DO ASAAS COM ESTADO — para os testes da frente FIN (lote N2).
 *
 * Responde ao que o `AsaasHttpClient` realmente pede, no formato da API v3, e
 * GUARDA o que criou: é o que deixa um teste perguntar "o provedor tem esta
 * cobrança como paga?" depois que o webhook se perdeu, estornar pelo ERP e ver
 * a cobrança virar REFUNDED lá, ou parcelar no cartão e ver as N parcelas que
 * o provedor gera com o mesmo `installment`.
 *
 * Nada sai deste processo: quem não passar por aqui cai no `fetch` global
 * bloqueado de cada teste.
 */
export interface CobrancaNoDuble {
  id: string;
  customer: string;
  value: number;
  billingType: string;
  status: string;
  externalReference: string;
  invoiceUrl: string;
  deleted: boolean;
  dueDate: string;
  dateCreated: string;
  paymentDate: string | null;
  description: string;
  /** Plano de parcelas do cartão: o mesmo id em todas as parcelas dele. */
  installment: string | null;
  installmentNumber: number | null;
}

export interface ChamadaAoDuble {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

export interface OpcoesDoDuble {
  /** O estorno é recusado pelo provedor com esta descrição. */
  recusarEstorno?: string;
  /** A consulta de cobrança (GET /payments/:id) cai por timeout. */
  consultaFora?: boolean;
  /** Prefixo dos ids, para duas operações não colidirem no mesmo teste. */
  prefixo?: string;
  /** Quantas criações acontecem LÁ e têm a resposta perdida (timeout). */
  perderRespostas?: number;
}

let sequencia = 0;

export function asaasComEstado(opcoes: OpcoesDoDuble = {}) {
  const cobrancas: CobrancaNoDuble[] = [];
  const chamadas: ChamadaAoDuble[] = [];
  const prefixo = opcoes.prefixo ?? 'TEST';
  let perder = opcoes.perderRespostas ?? 0;
  const talvezPerder = <T,>(resposta: T): T => {
    if (perder > 0) {
      perder -= 1;
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }
    return resposta;
  };

  const responder = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const naoAchou = () => responder({ errors: [{ code: 'not_found', description: 'Cobrança não encontrada.' }] }, 404);

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const endereco = String(url);
    const metodo = init?.method ?? 'GET';
    const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    chamadas.push({ method: metodo, url: endereco, body: corpo });
    const caminho = new URL(endereco).pathname.replace(/^\/v3/, '').replace(/^\/api\/v3/, '');

    if (caminho.endsWith('/customers') && metodo === 'POST') {
      sequencia += 1;
      return responder({ id: `cus_${prefixo}_${sequencia}` });
    }

    if (caminho.endsWith('/payments') && metodo === 'POST') {
      const parcelas = Number(corpo?.installmentCount ?? 1);
      const total = Number(corpo?.totalValue ?? corpo?.value ?? 0);
      const base = {
        customer: String(corpo?.customer ?? ''),
        billingType: String(corpo?.billingType ?? 'PIX'),
        status: 'PENDING',
        externalReference: String(corpo?.externalReference ?? ''),
        deleted: false,
        dueDate: String(corpo?.dueDate ?? '2026-09-12'),
        dateCreated: '2026-09-11',
        paymentDate: null,
        description: String(corpo?.description ?? ''),
      };
      if (parcelas > 1) {
        // Como o provedor faz: N cobranças, o mesmo `installment`, centavos
        // que sobram na primeira parcela.
        sequencia += 1;
        const plano = `ins_${prefixo}_${sequencia}`;
        const totalCents = Math.round(total * 100);
        const cadaCents = Math.floor(totalCents / parcelas);
        const sobra = totalCents - cadaCents * parcelas;
        const criadas: CobrancaNoDuble[] = [];
        for (let n = 1; n <= parcelas; n += 1) {
          sequencia += 1;
          const nova: CobrancaNoDuble = {
            ...base,
            id: `pay_${prefixo}_${sequencia}`,
            value: (cadaCents + (n === 1 ? sobra : 0)) / 100,
            invoiceUrl: `https://sandbox.asaas.com/i/${prefixo}_${sequencia}`,
            installment: plano,
            installmentNumber: n,
          };
          cobrancas.push(nova);
          criadas.push(nova);
        }
        return talvezPerder(responder(criadas[0]));
      }
      sequencia += 1;
      const nova: CobrancaNoDuble = {
        ...base,
        id: `pay_${prefixo}_${sequencia}`,
        value: Number(corpo?.value ?? 0),
        invoiceUrl: `https://sandbox.asaas.com/i/${prefixo}_${sequencia}`,
        installment: null,
        installmentNumber: null,
      };
      cobrancas.push(nova);
      return talvezPerder(responder(nova));
    }

    if (metodo === 'GET' && caminho === '/payments') {
      const busca = new URL(endereco).searchParams;
      const ref = busca.get('externalReference');
      const plano = busca.get('installment');
      const data = cobrancas.filter(
        (c) => (ref === null || c.externalReference === ref) && (plano === null || c.installment === plano),
      );
      return responder({ object: 'list', hasMore: false, totalCount: data.length, data });
    }

    const umaCobranca = caminho.match(/^\/payments\/([^/]+)$/);
    if (metodo === 'GET' && umaCobranca) {
      if (opcoes.consultaFora) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      const alvo = cobrancas.find((c) => c.id === umaCobranca[1]);
      return alvo ? responder(alvo) : naoAchou();
    }

    const estorno = caminho.match(/^\/payments\/([^/]+)\/refund$/);
    if (metodo === 'POST' && estorno) {
      const alvo = cobrancas.find((c) => c.id === estorno[1]);
      if (!alvo) return naoAchou();
      if (opcoes.recusarEstorno) {
        return responder({ errors: [{ code: 'invalid_action', description: opcoes.recusarEstorno }] }, 400);
      }
      alvo.status = 'REFUNDED';
      return responder(alvo);
    }

    const estornoDoPlano = caminho.match(/^\/installments\/([^/]+)\/refund$/);
    if (metodo === 'POST' && estornoDoPlano) {
      const doPlano = cobrancas.filter((c) => c.installment === estornoDoPlano[1]);
      if (doPlano.length === 0) return naoAchou();
      for (const c of doPlano) c.status = 'REFUNDED';
      return responder({ id: estornoDoPlano[1], status: 'REFUNDED' });
    }

    // `POST /payments/:id/cancel` não existe no Asaas (GAP-PRD-169): o dublê
    // deixou de responder a ele, para o código não voltar a chamá-lo.
    const exclusao = caminho.match(/^\/payments\/([^/]+)$/);
    if (metodo === 'DELETE' && exclusao) {
      const alvo = cobrancas.find((c) => c.id === exclusao[1]);
      if (alvo) alvo.deleted = true;
      return responder({ id: exclusao[1], deleted: true });
    }
    const exclusaoDoPlano = caminho.match(/^\/installments\/([^/]+)$/);
    if (metodo === 'DELETE' && exclusaoDoPlano) {
      for (const c of cobrancas.filter((x) => x.installment === exclusaoDoPlano[1])) c.deleted = true;
      return responder({ id: exclusaoDoPlano[1], deleted: true });
    }

    const qr = caminho.match(/^\/payments\/([^/]+)\/pixQrCode$/);
    if (qr) {
      return responder({
        payload: `00020126-PIX-${qr[1]}`,
        encodedImage: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        expirationDate: '2026-09-12 23:59:59',
      });
    }
    if (caminho.includes('/identificationField')) {
      return responder({ identificationField: '23793.38128 60000.000003 00000.000400 1 99990000030000' });
    }
    return responder({});
  }) as unknown as typeof fetch;

  /** O cliente pagou lá — sem webhook nenhum chegar aqui. */
  function pagar(id: string, status: 'RECEIVED' | 'CONFIRMED' = 'RECEIVED', valor?: number): CobrancaNoDuble {
    const alvo = cobrancas.find((c) => c.id === id);
    if (!alvo) throw new Error(`cobrança ${id} não existe no dublê`);
    alvo.status = status;
    alvo.paymentDate = '2026-09-11';
    if (valor !== undefined) alvo.value = valor;
    return alvo;
  }

  const doMetodo = (metodo: string, trecho: RegExp) =>
    chamadas.filter((c) => c.method === metodo && trecho.test(new URL(c.url).pathname));

  return {
    fetchImpl,
    cobrancas,
    chamadas,
    pagar,
    criacoes: () => doMetodo('POST', /\/payments$/),
    estornos: () => doMetodo('POST', /\/refund$/),
    consultas: () => doMetodo('GET', /\/payments\/[^/]+$/),
  };
}
