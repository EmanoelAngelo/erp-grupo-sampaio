/**
 * A PLAQUINHA DE UMA MÁQUINA — reimprimir, trocar e reimprimir pela unidade
 * (GAP-PRD-107, GAP-PRD-190).
 *
 *   reimprimir         mesma plaquinha (mesmo número, mesmo QR), pela ficha da
 *                      máquina na Oficina: `POST /core/labels/equipment/sheet`;
 *   trocar             outra plaquinha do pool entra na máquina e a velha é
 *                      aposentada: `POST /core/equipment-tags/:tagId/replace`;
 *   reimprimir (loja)  a PJ Motors, pela UNIDADE que vende:
 *                      `POST /core/units/:id/equipment/sheet`.
 *
 * A folha volta como HTML pronto, desenhado no servidor em milímetro; a tela
 * só a abre numa janela para imprimir.
 */
import { apiRequest } from './client';

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

  livres: () =>
    apiRequest<{ items: PlaquinhaLivre[]; usaPlaquinha: boolean }>(
      '/core/equipment-tags?status=disponivel',
    ).then((r) => ({ items: Array.isArray(r?.items) ? r.items : [], usaPlaquinha: Boolean(r?.usaPlaquinha) })),

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
