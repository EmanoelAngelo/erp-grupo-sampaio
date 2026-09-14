/**
 * A IDENTIDADE DA MÁQUINA — tipo, placa, km, fotos e correção (GAP-PRD-106).
 *
 * O vocabulário do tipo é o MESMO do servidor (`EquipmentIdentityRules`): a
 * tela oferece só o que a rota aceita, e o texto livre antigo continua sendo
 * mostrado como veio até alguém o corrigir.
 */
import { apiRequest } from './client';

export const CATEGORIAS_DE_EQUIPAMENTO = [
  { value: 'moto', label: 'Moto' },
  { value: 'scooter', label: 'Scooter' },
  { value: 'bicicleta_eletrica', label: 'Bicicleta elétrica' },
  { value: 'patinete', label: 'Patinete' },
  { value: 'celular', label: 'Celular' },
  { value: 'outro', label: 'Outro' },
] as const;

/** O tipo como a pessoa lê — o texto antigo sai como foi gravado. */
export function rotuloDaCategoria(valor: unknown): string | null {
  const s = String(valor ?? '').trim();
  if (!s) return null;
  return CATEGORIAS_DE_EQUIPAMENTO.find((c) => c.value === s)?.label ?? s;
}

/** Celular não tem placa nem quilometragem: a tela nem pergunta. */
export function temPlacaEKm(categoria: string): boolean {
  return categoria !== 'celular';
}

/** Placa legível: ABC1D23 → ABC-1D23. */
export function placaLegivel(placa: unknown): string | null {
  const s = String(placa ?? '').trim();
  if (!s) return null;
  return s.length === 7 ? `${s.slice(0, 3)}-${s.slice(3)}` : s;
}

export interface FotoDaMaquina {
  id: string;
  url: string;
  kind: string;
  caption: string | null;
  created_at: string;
}

export const TIPOS_DE_FOTO = [
  { value: 'frente', label: 'Frente' },
  { value: 'lateral', label: 'Lateral' },
  { value: 'traseira', label: 'Traseira' },
  { value: 'painel', label: 'Painel' },
  { value: 'chassi', label: 'Chassi' },
  { value: 'outra', label: 'Outra' },
] as const;

export const equipamentoIdentidadeApi = {
  corrigir: (equipmentId: string, corpo: Record<string, unknown>) =>
    apiRequest<{ mudancas: { campo: string }[] }>(`/core/equipment/${equipmentId}/identidade`, {
      method: 'PATCH',
      body: corpo,
    }),

  fotos: (equipmentId: string) =>
    apiRequest<{ items: FotoDaMaquina[] }>(`/core/equipment/${equipmentId}/photos`).then((r) =>
      Array.isArray(r?.items) ? r.items : [],
    ),

  subirFoto: (equipmentId: string, corpo: { dataUrl: string; kind: string; caption?: string }) =>
    apiRequest<FotoDaMaquina>(`/core/equipment/${equipmentId}/photos`, { method: 'POST', body: corpo }),

  apagarFoto: (equipmentId: string, fotoId: string) =>
    apiRequest<void>(`/core/equipment/${equipmentId}/photos/${fotoId}`, { method: 'DELETE' }),
};
