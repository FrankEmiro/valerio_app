/**
 * columns.js – Definizione colonne export e gruppi per la UI
 */

const ALL_COLUMNS = [
  'Parent code',
  'Nome del prodotto',
  'Brand',
  'Codice di riferimento',
  'Codice produttore',
  'Magazzino EU',
  'Magazzino US',
  'Meta titolo',
  'Meta descrizione',
  'Descrizione',
  'Applicazioni',
  'Prezzo di acquisto tasse escluse',
  'Prezzo di vendita tasse incl',
  'Categorie correlate1',
  'Categorie correlate2',
  'Categorie correlate3',
  'Categorie correlate4',
  'Categorie correlate5',
  'Categorie correlate6',
  ...Array.from({ length: 20 }, (_, i) => `Attributo ${i + 1}`),
  ...Array.from({ length: 20 }, (_, i) => `Valore ${i + 1}`),
  'File URL (PDF)',
  'Attributo',
  'Valore1',
  'Url',
  'Images url'
]

const COLUMN_GROUPS = [
  {
    id: 'identification',
    label: 'Identificazione',
    icon: '⬡',
    columns: ['Parent code', 'Nome del prodotto', 'Brand', 'Codice di riferimento', 'Codice produttore', 'Url']
  },
  {
    id: 'pricing',
    label: 'Prezzi & Stock',
    icon: '◈',
    columns: ['Prezzo di acquisto tasse escluse', 'Prezzo di vendita tasse incl', 'Magazzino EU', 'Magazzino US']
  },
  {
    id: 'seo',
    label: 'SEO',
    icon: '◉',
    columns: ['Meta titolo', 'Meta descrizione', 'Descrizione']
  },
  {
    id: 'applications',
    label: 'Compatibilità Moto',
    icon: '◎',
    columns: ['Applicazioni']
  },
  {
    id: 'categories',
    label: 'Categorie',
    icon: '▦',
    columns: [
      'Categorie correlate1', 'Categorie correlate2', 'Categorie correlate3',
      'Categorie correlate4', 'Categorie correlate5', 'Categorie correlate6'
    ]
  },
  {
    id: 'attributes',
    label: 'Attributi Tecnici',
    icon: '≡',
    columns: [
      ...Array.from({ length: 20 }, (_, i) => `Attributo ${i + 1}`),
      ...Array.from({ length: 20 }, (_, i) => `Valore ${i + 1}`),
      'Attributo', 'Valore1'
    ]
  },
  {
    id: 'media',
    label: 'Media & File',
    icon: '▣',
    columns: ['Images url', 'File URL (PDF)']
  }
]

/**
 * Filtra e ordina le colonne mantenendo l'ordine originale
 * @param {string[]|null} enabledColumns - null = tutte
 */
function filterColumns(enabledColumns) {
  if (!enabledColumns || enabledColumns.length === 0) return ALL_COLUMNS
  const enabledSet = new Set(enabledColumns)
  return ALL_COLUMNS.filter(c => enabledSet.has(c))
}

module.exports = { ALL_COLUMNS, COLUMN_GROUPS, filterColumns }
