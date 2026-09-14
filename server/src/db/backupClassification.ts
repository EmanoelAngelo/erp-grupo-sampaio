/**
 * ============================================================================
 * QUAL BACKUP AINDA CARREGA A CHAVE ANTIGA
 * ============================================================================
 *
 * Um backup é uma fotografia do banco, e o banco carrega os segredos CIFRADOS.
 * Rotacionar a chave do cofre não alcança as fotografias já tiradas: cada uma
 * continua com os cinco segredos selados pela chave que valia naquele dia.
 *
 * Enquanto essa chave era a PADRÃO de desenvolvimento — escrita neste
 * repositório —, cada backup era um arquivo que qualquer leitor do repositório
 * abriria. Havia 529 no bucket remoto e 717 no disco local.
 *
 * Depois da rotação, os backups novos são outra coisa: só abrem com uma chave
 * que existe apenas no `.env` do servidor. Os dois grupos não podem ser tratados
 * da mesma forma, e é por isso que existe este módulo.
 *
 * ## O que ele NÃO faz
 *
 * Não apaga nada, e não é por timidez. O backup pré-rotação continua sendo o
 * único caminho de volta se algo na rotação tiver escapado — e "algo escapou"
 * é uma frase que só aparece depois. Apagar o histórico antes de existir um
 * backup novo VALIDADO troca um problema de exposição por um de perda.
 *
 * A ordem certa é:
 *
 *   1. existe backup pós-rotação, subido e conferido;
 *   2. existe restauração conferida a partir dele;
 *   3. a retenção mínima está satisfeita SEM contar os legados;
 *   4. só então o expurgo dos legados é seguro.
 *
 * `podeExpurgarLegados` responde exatamente isso, e responde não por padrão.
 */

/** O selo diz com QUAL chave os segredos daquele arquivo foram fechados. */
export type SeloDoBackup =
  /** Selado pela chave anterior à rotação — publicada, no caso desta instalação. */
  | 'LEGACY_ENCRYPTION_KEY'
  /** Selado pela chave atual. Só abre com o que está no `.env` do servidor. */
  | 'CURRENT_ENCRYPTION_KEY'
  /** Não houve rotação: não há dois grupos a separar. */
  | 'UNKNOWN';

export interface BackupClassificado {
  nome: string;
  criadoEm: string;
  bytes: number;
  selo: SeloDoBackup;
}

/**
 * O selo de UM arquivo.
 *
 * A comparação é por instante de criação contra a marca da rotação. Empate
 * conta como legado: um arquivo criado no mesmo milissegundo da rotação pode
 * ter sido tirado antes dela, e o lado seguro aqui é o pessimista.
 */
export function classificarBackup(
  criadoEm: string,
  rotacionadoEm: string | null,
): SeloDoBackup {
  if (!rotacionadoEm) return 'UNKNOWN';
  return criadoEm <= rotacionadoEm ? 'LEGACY_ENCRYPTION_KEY' : 'CURRENT_ENCRYPTION_KEY';
}

export function classificarBackups(
  arquivos: Array<{ nome: string; criadoEm: string; bytes: number }>,
  rotacionadoEm: string | null,
): BackupClassificado[] {
  return arquivos
    .map((a) => ({ ...a, selo: classificarBackup(a.criadoEm, rotacionadoEm) }))
    .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}

export interface CondicoesDoExpurgo {
  /** Já existe backup pós-rotação subido ao destino remoto? */
  backupNovoValidado: boolean;
  /** Já foi restaurado um backup pós-rotação, e o cofre abriu? */
  restauracaoValidada: boolean;
  /** Quantos backups pós-rotação existem. */
  novosDisponiveis: number;
  /** O piso de retenção — quantos backups o sistema nunca deve ficar abaixo. */
  retencaoMinima: number;
}

export interface VeredictoDoExpurgo {
  permitido: boolean;
  /** Por que não, em texto que serve para mostrar a quem pediu. */
  motivos: string[];
}

/**
 * Pode-se apagar os legados?
 *
 * Responde NÃO enquanto qualquer uma das condições faltar, e diz quais. A
 * pergunta é feita antes de um apagamento irreversível, então o silêncio não
 * serve de resposta.
 */
export function podeExpurgarLegados(c: CondicoesDoExpurgo): VeredictoDoExpurgo {
  const motivos: string[] = [];
  if (!c.backupNovoValidado) {
    motivos.push('não há backup pós-rotação confirmado no destino remoto');
  }
  if (!c.restauracaoValidada) {
    motivos.push('nenhum backup pós-rotação foi restaurado e conferido');
  }
  if (c.novosDisponiveis < c.retencaoMinima) {
    motivos.push(
      `a retenção mínima é ${c.retencaoMinima} e só há ${c.novosDisponiveis} backup(s) `
        + 'pós-rotação: apagar os legados deixaria o sistema abaixo do piso',
    );
  }
  return { permitido: motivos.length === 0, motivos };
}
