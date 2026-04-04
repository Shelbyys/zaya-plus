// ================================================================
// GOOGLE PLACES — Busca de empresas, endereços, telefones
// ================================================================
import { log } from '../logger.js';

const API_KEY = () => process.env.GOOGLE_PLACES_KEY;
const BASE = 'https://places.googleapis.com/v1/places';

// ================================================================
// BUSCAR EMPRESAS (Text Search)
// ================================================================
export async function buscarEmpresas(query, opcoes = {}) {
  const key = API_KEY();
  if (!key) throw new Error('GOOGLE_PLACES_KEY não configurada no .env');

  log.ai.info({ query, cidade: opcoes.cidade }, 'Places: buscando empresas');

  const searchQuery = opcoes.cidade ? `${query} em ${opcoes.cidade}` : query;

  const response = await fetch(`${BASE}:searchText`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.currentOpeningHours,places.businessStatus,places.googleMapsUri,places.types',
    },
    body: JSON.stringify({
      textQuery: searchQuery,
      languageCode: 'pt-BR',
      maxResultCount: opcoes.limite || 10,
      ...(opcoes.latitude && opcoes.longitude ? {
        locationBias: {
          circle: {
            center: { latitude: opcoes.latitude, longitude: opcoes.longitude },
            radius: opcoes.raio || 10000,
          },
        },
      } : {}),
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Google Places erro: ${err.error?.message || response.status}`);
  }

  const data = await response.json();
  const places = data.places || [];

  log.ai.info({ total: places.length }, 'Places: resultados encontrados');

  return places.map(p => ({
    nome: p.displayName?.text || '',
    endereco: p.formattedAddress || '',
    telefone: p.nationalPhoneNumber || p.internationalPhoneNumber || '',
    telefone_intl: p.internationalPhoneNumber || '',
    website: p.websiteUri || '',
    avaliacao: p.rating || 0,
    total_avaliacoes: p.userRatingCount || 0,
    status: p.businessStatus === 'OPERATIONAL' ? 'aberto' : p.businessStatus || '',
    horario: p.currentOpeningHours?.weekdayDescriptions?.join(' | ') || '',
    google_maps: p.googleMapsUri || '',
    tipo: p.types?.slice(0, 3)?.join(', ') || '',
  }));
}

// ================================================================
// DETALHES DE UMA EMPRESA (por place_id)
// ================================================================
export async function detalhesEmpresa(placeId) {
  const key = API_KEY();
  if (!key) throw new Error('GOOGLE_PLACES_KEY não configurada');

  const response = await fetch(`${BASE}/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'displayName,formattedAddress,nationalPhoneNumber,internationalPhoneNumber,websiteUri,rating,userRatingCount,currentOpeningHours,businessStatus,googleMapsUri,reviews,editorialSummary',
    },
  });

  if (!response.ok) throw new Error(`Erro: ${response.status}`);
  const p = await response.json();

  return {
    nome: p.displayName?.text || '',
    endereco: p.formattedAddress || '',
    telefone: p.nationalPhoneNumber || p.internationalPhoneNumber || '',
    website: p.websiteUri || '',
    avaliacao: p.rating || 0,
    total_avaliacoes: p.userRatingCount || 0,
    horario: p.currentOpeningHours?.weekdayDescriptions?.join('\n') || '',
    google_maps: p.googleMapsUri || '',
    resumo: p.editorialSummary?.text || '',
    reviews: (p.reviews || []).slice(0, 3).map(r => ({
      autor: r.authorAttribution?.displayName || '',
      nota: r.rating || 0,
      texto: r.text?.text?.slice(0, 200) || '',
    })),
  };
}
