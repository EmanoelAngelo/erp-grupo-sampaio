/**
 * A BANCADA DE ENTRADA — onde cada perfil abre OS e cadastra a máquina do
 * cliente (GAP-PRD-099).
 *
 * ## O defeito
 *
 * `POST /workshop/orders` e `POST /equipment` nomeiam o caixa da oficina e o
 * atendente, e resolviam a bancada por `resolveWorkshop` — que só alcança as
 * bancadas em que o usuário é MEMBRO (`core_workshop_members`). No banco da
 * loja só os mecânicos são membros: o usuário "PDV Oficina" não tem linha lá.
 * Resultado: quem a rota nomeia levava 400/403 sempre, e o balcão dependia de
 * um mecânico ou do gerente para receber a máquina de um cliente. O contorno
 * — vincular o caixa como "membro" — faria o caixa contar como bancada.
 *
 * ## A régua de cada perfil
 *
 *   - gestão da oficina (`admin_geral`, `gestor`, `gerente_oficina`): toda
 *     bancada ativa da empresa, como sempre;
 *   - balcão (`atendente`, `operador_caixa_oficina`): toda bancada ativa da
 *     EMPRESA — a mesma régua que `POST /workshop/parts` já usa para o
 *     estoquista (`exigirBancadaComPeca`). Eles recebem o cliente de qualquer
 *     bancada da loja em que trabalham;
 *   - mecânico: só as bancadas em que é membro. A filiação continua sendo o
 *     que separa a bancada de celulares da de mobilidade para quem conserta.
 *
 * Com uma bancada só no alcance, ela é assumida; com mais de uma, quem abre
 * escolhe (a tela pede a lista em `GET /workshop/entrada`). A empresa é
 * sempre a fronteira: bancada de outra empresa nunca está na lista.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

export interface BancadaDeEntrada {
  id: string;
  company_id: string;
  slug: string;
  name: string;
  kind: string;
}

const GESTAO_DA_OFICINA = ['admin_geral', 'gestor', 'gerente_oficina'];
/** Quem atende o cliente no balcão da oficina — não é membro de bancada. */
const BALCAO_DA_OFICINA = ['atendente', 'operador_caixa_oficina'];

interface QuemAbre {
  companyId: string;
  userId: string;
  profiles: string[];
}

function bancadasAtivas(companyId: string): BancadaDeEntrada[] {
  return getConnection()
    .prepare(
      `SELECT id, company_id, slug, name, kind FROM core_workshops
        WHERE company_id = ? AND active = 1 ORDER BY name`,
    )
    .all(companyId) as unknown as BancadaDeEntrada[];
}

/** As bancadas em que esta pessoa pode abrir OS e cadastrar equipamento. */
export function bancadasDeEntrada(quem: QuemAbre): BancadaDeEntrada[] {
  ensureCoreSchema();
  const todas = bancadasAtivas(quem.companyId);
  const reguaDeEmpresa = quem.profiles.some(
    (p) => GESTAO_DA_OFICINA.includes(p) || BALCAO_DA_OFICINA.includes(p),
  );
  if (reguaDeEmpresa) return todas;

  const vinculo = getConnection().prepare(
    'SELECT 1 AS ok FROM core_workshop_members WHERE workshop_id = ? AND user_id = ?',
  );
  return todas.filter((w) => Boolean((vinculo.get(w.id, quem.userId) as { ok?: number } | undefined)?.ok));
}

/**
 * A bancada onde esta abertura acontece.
 *
 * `pedida` é o `workshopId` (id ou slug) que veio na requisição; ausente, a
 * única bancada do alcance é assumida.
 */
export function bancadaDeEntrada(quem: QuemAbre & { pedida?: string | null }): BancadaDeEntrada {
  const permitidas = bancadasDeEntrada(quem);
  const pedida = String(quem.pedida ?? '').trim();

  if (pedida) {
    const achada = permitidas.find((w) => w.id === pedida || w.slug === pedida);
    if (!achada) {
      throw new ApiError('CORE_WORKSHOP_FORBIDDEN', 'Oficina não autorizada para este usuário.', 403);
    }
    return achada;
  }

  if (permitidas.length === 1) return permitidas[0];

  if (permitidas.length === 0) {
    if (bancadasAtivas(quem.companyId).length === 0) {
      throw new ApiError(
        'CORE_WORKSHOP_NOT_FOUND',
        'Esta empresa não tem oficina cadastrada — não há bancada onde abrir a OS.',
        404,
      );
    }
    // Só o mecânico chega aqui: a régua dele é a filiação.
    throw new ApiError(
      'CORE_WORKSHOP_FORBIDDEN',
      'Você não está vinculado a nenhuma bancada desta empresa. Peça ao gerente da oficina '
        + 'para vincular você em Oficinas.',
      403,
    );
  }

  throw new ApiError(
    'CORE_WORKSHOP_REQUIRED',
    'Esta empresa tem mais de uma bancada: escolha em qual delas a OS (ou o equipamento) entra.',
    400,
    { bancadas: permitidas.map((w) => ({ id: w.id, name: w.name })) },
  );
}
