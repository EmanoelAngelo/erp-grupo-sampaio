/**
 * O DÍGITO VERIFICADOR DO CÓDIGO DE BARRAS DO FABRICANTE.
 *
 * O cadastro aceitava qualquer sequência de números como "EAN": 7894900011518
 * (um dígito errado no fim) entrava sem aviso. Esse código nunca é lido pelo
 * scanner — a leitora confere o verificador e descarta a leitura —, e a
 * etiqueta impressa com ele sai com barras que nenhum PDV reconhece. O erro só
 * aparece no balcão, com o cliente na frente.
 *
 * GTIN-8, GTIN-12 (UPC-A), GTIN-13 (EAN-13) e GTIN-14 usam o mesmo cálculo:
 * pesos 3 e 1 alternados a partir do dígito à esquerda do verificador. Código
 * numérico com outro comprimento, ou com letras, não é GTIN (é código interno,
 * Code128 da loja) e não passa por esta conta.
 */
import { ApiError } from '../../utils/errors.js';

const COMPRIMENTOS_GTIN = new Set([8, 12, 13, 14]);

/** O código tem o formato de um GTIN (só dígitos, 8/12/13/14)? */
export function pareceGtin(codigo: string): boolean {
  return /^\d+$/.test(codigo) && COMPRIMENTOS_GTIN.has(codigo.length);
}

/** O verificador calculado para os dígitos antes dele. */
export function digitoVerificadorGtin(semVerificador: string): number {
  let soma = 0;
  const n = semVerificador.length;
  for (let i = 0; i < n; i += 1) {
    // O dígito imediatamente à esquerda do verificador pesa 3.
    const peso = (n - i) % 2 === 1 ? 3 : 1;
    soma += Number(semVerificador[i]) * peso;
  }
  return (10 - (soma % 10)) % 10;
}

/** GTIN com verificador correto. Falso para o que não tem formato de GTIN. */
export function gtinValido(codigo: string): boolean {
  if (!pareceGtin(codigo)) return false;
  return digitoVerificadorGtin(codigo.slice(0, -1)) === Number(codigo[codigo.length - 1]);
}

/**
 * Recusa o código com cara de GTIN e verificador errado. O que não tem cara de
 * GTIN (código interno alfanumérico, Code128) passa: não há verificador a
 * conferir.
 */
export function exigirCodigoDeBarrasValido(codigo: string): void {
  if (pareceGtin(codigo) && !gtinValido(codigo)) {
    const certo = digitoVerificadorGtin(codigo.slice(0, -1));
    throw new ApiError(
      'CORE_BARCODE_INVALID',
      `O código de barras ${codigo} tem o dígito verificador errado (o último deveria ser ${certo}). `
        + 'Confira os números na embalagem: o scanner não leria este código.',
      400,
    );
  }
}
