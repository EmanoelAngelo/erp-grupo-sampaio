/**
 * A PLAQUINHA DE UMA MÁQUINA — reimprimir, trocar e reimprimir pela unidade
 * (GAP-PRD-107, GAP-PRD-190) — e a plaquinha da PJ Motors na moto do estoque
 * (P0 das plaquinhas).
 *
 *   reimprimir         mesma plaquinha (mesmo número, mesmo QR), pela ficha da
 *                      máquina na Oficina: `POST /core/labels/equipment/sheet`;
 *   trocar             outra plaquinha do pool entra na máquina e a velha é
 *                      aposentada: `POST /core/equipment-tags/:tagId/replace`;
 *   reimprimir (loja)  a PJ Motors, pela UNIDADE que vende (serve à plaquinha
 *                      de máquina e ao adesivo da PJ):
 *                      `POST /core/units/:id/equipment/sheet`;
 *   colar (loja)       o adesivo liberado do lote da PJ entra na moto do
 *                      estoque: `POST /core/units/:id/tag`;
 *   soltar (loja)      a moto errada, ainda no pátio — o adesivo volta livre:
 *                      `DELETE /core/units/:id/tag`;
 *   trocar (loja)      o adesivo estragado da moto da PJ:
 *                      `POST /core/units/:id/tag/replace`.
 *
 * A folha volta como HTML pronto, desenhado no servidor em milímetro; a tela
 * só a abre numa janela para imprimir.
 */
import { apiRequest } from './client';
import type { PlaquinhaDoPoolDaUnidade } from './core';

export interface FolhaDePlaquinha {
  html: string;
  plaquinhas: number;
  abaixoDoPiso?: boolean;
  baseUrlConfigurada?: boolean;
}

export interface PlaquinhaLivre {
  id: string;
  public_id: number;
  publicIdLabel: string;
}

export const plaquinhaDaMaquinaApi = {
  reimprimir: (equipmentId: string) =>
    apiRequest<FolhaDePlaquinha>('/core/labels/equipment/sheet', {
      method: 'POST',
      body: { equipmentIds: [equipmentId] },
    }),

  /** As plaquinhas liberadas e sem dono; `busca` é o número (#0042, 0042 ou 42). */
  livres: (busca?: string) => {
    const termo = String(busca ?? '').trim();
    return apiRequest<{ items: PlaquinhaLivre[]; usaPlaquinha: boolean }>(
      `/core/equipment-tags?status=disponivel${termo ? `&busca=${encodeURIComponent(termo)}` : ''}`,
    ).then((r) => ({ items: Array.isArray(r?.items) ? r.items : [], usaPlaquinha: Boolean(r?.usaPlaquinha) }));
  },

  /**
   * Os adesivos LIVRES da PJ que podem ir para esta moto — a leitura estreita
   * do painel de colar e trocar em Estoque › Unidades, sob a mesma capability
   * das duas escritas (`inventory.units.manage`). A lista do pool (`livres`)
   * exige `workshop.tags.view`, que o modelo "Estoque" não tem.
   */
  livresParaAUnidade: (unitId: string, busca?: string) => {
    const termo = String(busca ?? '').trim();
    return apiRequest<{ items: PlaquinhaLivre[] }>(
      `/core/units/${encodeURIComponent(unitId)}/tag/livres${termo ? `?busca=${encodeURIComponent(termo)}` : ''}`,
    ).then((r) => ({ items: Array.isArray(r?.items) ? r.items : [] }));
  },

  trocar: (input: { equipmentId: string; novaTagId: string; motivo: string }) =>
    apiRequest<{ anterior: string; atual: string }>(
      `/core/equipment-tags/${input.novaTagId}/replace`,
      { method: 'POST', body: { equipmentId: input.equipmentId, motivo: input.motivo } },
    ),

  reimprimirPelaUnidade: (unitId: string) =>
    apiRequest<FolhaDePlaquinha & { publicIdLabel: string }>(
      `/core/units/${unitId}/equipment/sheet`,
      { method: 'POST', body: {} },
    ),

  colarNaUnidade: (unitId: string, tagId: string) =>
    apiRequest<{ plaquinha: PlaquinhaDoPoolDaUnidade }>(`/core/units/${unitId}/tag`, {
      method: 'POST',
      body: { tagId },
    }),

  soltarDaUnidade: (unitId: string) =>
    apiRequest<void>(`/core/units/${unitId}/tag`, { method: 'DELETE' }),

  trocarNaUnidade: (unitId: string, input: { novaTagId: string; motivo: string }) =>
    apiRequest<{ anterior: string; atual: string }>(`/core/units/${unitId}/tag/replace`, {
      method: 'POST',
      body: { novaTagId: input.novaTagId, motivo: input.motivo },
    }),
};

/**
 * Escreve a folha na janela aberta DENTRO do clique (aberta depois do `await`,
 * o navegador a trata como pop-up não pedido e bloqueia). Sem janela, devolve
 * falso e quem chamou diz à pessoa o que houve.
 */
export function escreverFolha(janela: Window | null, html: string): boolean {
  if (!janela) return false;
  janela.document.open();
  janela.document.write(html);
  janela.document.close();
  return true;
}
