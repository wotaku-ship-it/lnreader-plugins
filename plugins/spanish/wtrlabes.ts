import { Plugin } from '@/types/plugin';
import { fetchApi } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { CheerioAPI, load as parseHTML } from 'cheerio';
import { gcm } from '@libs/aes';

class WTRLAB implements Plugin.PluginBase {
  id = 'WTRLAB';
  name = 'WTR-LAB';
  site = 'https://wtr-lab.com/';
  version = '1.0.0';
  icon = 'src/es/wtrlab/icon.png';
  sourceLang = 'es/';
  baggage = '';
  trace = '';

  get headers(): Record<string, string> {
    return {
      baggage: this.baggage,
      'sentry-trace': this.trace,
    };
  }

  async popularNovels(
    page: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    let link = this.site + this.sourceLang + 'novel-list?';

    const params = new URLSearchParams();
    params.append('orderBy', filters.orderBy.value);
    params.append('order', filters.order.value);
    params.append('status', filters.status.value);
    params.append('release_status', filters.release_status.value);
    params.append('addition_age', filters.addition_age.value);
    params.append('page', page.toString());

    if (filters.search.value) {
      params.append('text', filters.search.value);
    }

    if (
      filters.genres.value?.include &&
      filters.genres.value.include.length > 0
    ) {
      params.append('gi', filters.genres.value.include.join(','));
      params.append('gc', filters.genre_operator.value);
    }
    if (
      filters.genres.value?.exclude &&
      filters.genres.value.exclude.length > 0
    ) {
      params.append('ge', filters.genres.value.exclude.join(','));
    }

    if (filters.tags.value?.include && filters.tags.value.include.length > 0) {
      params.append('ti', filters.tags.value.include.join(','));
      params.append('tc', filters.tag_operator.value);
    }
    if (filters.tags.value?.exclude && filters.tags.value.exclude.length > 0) {
      params.append('te', filters.tags.value.exclude.join(','));
    }

    if (filters.folders.value) {
      params.append('folders', filters.folders.value);
    }
    if (filters.library_exclude.value) {
      params.append('le', filters.library_exclude.value);
    }

    if (filters.min_chapters.value) {
      params.append('count_value', filters.min_chapters.value);
    }
    if (filters.min_rating.value) {
      params.append('minr', filters.min_rating.value);
    }
    if (filters.min_review_count.value) {
      params.append('minrc', filters.min_review_count.value);
    }

    if (showLatestNovels) {
      const response = await fetchApi(this.site + 'api/home/recent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ page: page }),
      });

      const recentNovel: JsonNovel = await response.json();

      // Parse novels from JSON
      const novels: Plugin.NovelItem[] = recentNovel.data.map(
        (datum: Datum) => ({
          name: datum.serie.data.title || datum.serie.slug || '',
          cover: datum.serie.data.image,
          path:
            this.sourceLang +
              'serie-' +
              datum.serie.raw_id +
              '/' +
              datum.serie.slug || '',
        }),
      );

      return novels;
    } else {
      const finderPage = await fetchApi(this.site + 'es/novel-finder').then(
        res => res.text(),
      );
      const finderCheerio = parseHTML(finderPage);
      const nextData = finderCheerio('#__NEXT_DATA__').html();
      if (!nextData) {
        throw new Error('Could not find __NEXT_DATA__ on novel finder page');
      }
      const buildId = JSON.parse(nextData).buildId;

      link = `${this.site}_next/data/${buildId}/es/novel-finder.json?${params.toString()}`;

      const response = await fetchApi(link);
      const json = await response.json();
      const seenIds = new Set();

      const novels: Plugin.NovelItem[] = json.pageProps.series
        .filter((novel: Datum) => {
          if (seenIds.has(novel.raw_id)) {
            return false;
          }
          seenIds.add(novel.raw_id);
          return true;
        })
        .map((novel: Datum) => ({
          name: novel.data.title,
          cover: novel.data.image,
          path: `${this.sourceLang}serie-${novel.raw_id}/${novel.slug}`,
        }));

      return novels;
    }
  }

  async fetchTokens() {
    const body = await fetchApi(this.site + this.sourceLang).then(res =>
      res.text(),
    );
    const $ = parseHTML(body);

    this.baggage = $('meta[name="baggage"]').attr('content') ?? '';
    this.trace = $('meta[name="sentry-trace"]').attr('content') ?? '';
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const body = await fetchApi(this.site + novelPath).then(res => res.text());
    const loadedCheerio = parseHTML(body);

    const baggage = loadedCheerio('meta[name="baggage"]').attr('content');
    const trace = loadedCheerio('meta[name="sentry-trace"]').attr('content');

    if (baggage && trace) {
      this.baggage = baggage;
      this.trace = trace;
    } else if (!this.baggage || !this.trace) {
      await this.fetchTokens();
    }

    const nextDataElement = loadedCheerio('#__NEXT_DATA__');
    const nextDataText = nextDataElement.html();

    let rawId: number | null = null;
    let slug: string | null = null;
    let chapterCount = 0;

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: loadedCheerio('h1.text-uppercase').text(),
      summary: loadedCheerio('.lead').text().trim(),
    };

    if (nextDataText) {
      try {
        const jsonData = JSON.parse(nextDataText);
        const serieData = jsonData?.props?.pageProps?.serie?.serie_data;

        if (serieData) {
          novel.name = serieData.data?.title || '';
          novel.cover = serieData.data?.image || '';
          novel.summary = serieData.data?.description || '';
          novel.author = serieData.data?.author || '';
          rawId = serieData.raw_id || null;
          slug = serieData.slug || null;

          switch (serieData.status) {
            case 0:
              novel.status = 'En emisión';
              break;
            case 1:
              novel.status = 'Completado';
              break;
            default:
              novel.status = 'Desconocido';
          }
        }
      } catch (error) {
        console.error('Failed to parse __NEXT_DATA__:', error);
      }
    }

    if (!novel.name) {
      novel.name =
        loadedCheerio('h1.text-uppercase').text() ||
        loadedCheerio('h1.long-title').text() ||
        loadedCheerio('.title-wrap h1').text().trim();
    }

    if (!novel.cover) {
      novel.cover =
        loadedCheerio('.image-wrap img').attr('src') ||
        loadedCheerio('.img-wrap > img').attr('src');
    }

    if (!novel.summary) {
      novel.summary =
        loadedCheerio('.description').text().trim() ||
        loadedCheerio('.desc-wrap .description').text().trim() ||
        loadedCheerio('.lead').text().trim();
    }

    const genres =
      loadedCheerio('td:contains("Género")')
        .next()
        .find('a')
        .map((i, el) =>
          loadedCheerio(el)
            .text()
            .replace(/<!--.*?-->/g, '')
            .trim(),
        )
        .toArray() ||
      loadedCheerio('td:contains("Genre")')
        .next()
        .find('a')
        .map((i, el) =>
          loadedCheerio(el)
            .text()
            .replace(/<!--.*?-->/g, '')
            .trim(),
        )
        .toArray() ||
      loadedCheerio('.genre')
        .map((i, el) =>
          loadedCheerio(el)
            .text()
            .replace(/<!--.*?-->/g, '')
            .trim(),
        )
        .toArray() ||
      loadedCheerio('.genres .genre')
        .map((i, el) =>
          loadedCheerio(el)
            .text()
            .replace(/<!--.*?-->/g, '')
            .trim(),
        )
        .toArray();

    if (genres.length > 0) {
      novel.genres = genres
        .map(g => g.replace(/,$/, '').trim())
        .filter(genre => genre && genre.length > 0)
        .join(', ');
    }

    const tags =
      loadedCheerio('td:contains("Etiquetas")')
        .next()
        .find('a')
        .map((i, el) =>
          loadedCheerio(el)
            .text()
            .replace(/<!--.*?-->/g, '')
            .replace(/,$/, '')
            .trim(),
        )
        .toArray() ||
      loadedCheerio('td:contains("Tags")')
        .next()
        .find('a')
        .map((i, el) =>
          loadedCheerio(el)
            .text()
            .replace(/<!--.*?-->/g, '')
            .replace(/,$/, '')
            .trim(),
        )
        .toArray() ||
      loadedCheerio('.tag')
        .map((i, el) =>
          loadedCheerio(el)
            .text()
            .replace(/<!--.*?-->/g, '')
            .replace(/,$/, '')
            .trim(),
        )
        .toArray() ||
      loadedCheerio('.tags .tag')
        .map((i, el) =>
          loadedCheerio(el)
            .text()
            .replace(/<!--.*?-->/g, '')
            .replace(/,$/, '')
            .trim(),
        )
        .toArray();

    if (tags.length > 0) {
      const existingGenres = novel.genres ? novel.genres.split(', ') : [];
      const allGenres = [...existingGenres, ...tags].filter(
        genre => genre && genre.length > 0,
      );
      const uniqueGenres = allGenres.filter(
        (genre, index) => allGenres.indexOf(genre) === index,
      );
      novel.genres = uniqueGenres.join(', ');
    }

    if (!novel.author) {
      novel.author =
        loadedCheerio('td:contains("Autor")')
          .next()
          .text()
          .replace(/[\t\n]/g, '')
          .trim() ||
        loadedCheerio('td:contains("Author")')
          .next()
          .text()
          .replace(/[\t\n]/g, '')
          .trim() ||
        loadedCheerio('td:contains("Autor") + td')
          .text()
          .replace(/[\t\n]/g, '')
          .trim();
    }

    if (!novel.status) {
      novel.status =
        loadedCheerio('td:contains("Estado")')
          .next()
          .text()
          .replace(/[\t\n]/g, '')
          .trim() ||
        loadedCheerio('td:contains("Status")')
          .next()
          .text()
          .replace(/[\t\n]/g, '')
          .trim() ||
        loadedCheerio('.detail-line:contains("•")')
          .text()
          .match(/•\s*(\w+)/)?.[1] ||
        '';
    }

    const urlMatch = novelPath.match(/(?:serie|novel)-?(\d+)\/([^/]+)/);
    if (urlMatch) {
      rawId = parseInt(urlMatch[1]);
      slug = urlMatch[2];
    }

    const chapterCountText =
      loadedCheerio('.detail-line:contains("Capítulos")').text() ||
      loadedCheerio('.detail-line:contains("Chapters")').text() ||
      loadedCheerio('div:contains("Capítulos")').text();
    const chapterCountMatch = chapterCountText.match(/(\d+)\s+(?:Capítulos|Chapters?)/i);
    if (chapterCountMatch) {
      chapterCount = parseInt(chapterCountMatch[1]);
    }
    if (chapterCount === 0 && nextDataText) {
      try {
        const jsonData = JSON.parse(nextDataText);

        chapterCount =
          jsonData?.props?.pageProps?.serie?.serie_data?.chapter_count ?? 0;
      } catch (error) {
        console.error(
          'Failed to parse chapter_count from __NEXT_DATA__:',
          error,
        );
      }
    }
    let chapters: Plugin.ChapterItem[] = [];

    if (rawId && slug) {
      try {
        chapters = await this.fetchAllChapters(rawId, slug);
      } catch (error) {
        console.error('Failed to fetch chapters via API:', error);
        chapters = [];
      }
    } else {
      console.warn('Could not extract rawId or slug from page', {
        rawId,
        slug,
      });
    }

    novel.chapters = chapters;

    return novel;
  }

  async decrypt(encrypted: string, encKey: string) {
    try {
      let t = !1,
        u = encrypted;
      encrypted.startsWith('arr:')
        ? ((t = !0), (u = encrypted.substring(4)))
        : encrypted.startsWith('str:') && (u = encrypted.substring(4));
      const r = u.split(':');
      if (3 !== r.length) throw Error('Formato de datos encriptados inválido');

      const [iv, tag, ciphertext] = r.map(part =>
          Uint8Array.from(atob(part), e => e.charCodeAt(0)),
        ),
        combined = new Uint8Array(ciphertext.length + tag.length);

      combined.set(ciphertext), combined.set(tag, ciphertext.length);

      const keyBytes = new TextEncoder().encode(encKey.slice(0, 32));
      const aes = gcm(keyBytes, iv);
      const decrypted = aes.decrypt(combined);
      const m = new TextDecoder().decode(decrypted);

      if (t) return JSON.parse(m);
      return m;
    } catch (error) {
      console.error('Client-side decryption error:', error);
      const msg = { 'error': `<p>Error de desencriptación en el cliente:</p>${error}` };
      return msg;
    }
  }

  async getKey($: CheerioAPI): Promise<string> {
    const searchKey = 'TextEncoder().encode("';

    const URLs: string[] = [];
    let code: string | undefined;
    let index = -1;

    const scripts = $('head').find('script').toArray();
    for (const el of scripts) {
      const src = $(el).attr('src');
      if (!src) continue;
      if (URLs.includes(src)) continue;
      URLs.push(src);
    }

    for (const src of URLs) {
      const script = await fetchApi(`${this.site}${src}`);
      const raw = await script.text();
      index = raw.indexOf(searchKey);
      if (index >= 0) {
        code = raw;
        break;
      }
    }
    if (!code) {
      throw new Error('Failed to find Encryption Key');
    }
    const encKey = code.substring(index + 22, index + 54);
    return encKey;
  }

  async translate(data: string[]): Promise<string[]> {
    const contained = data.map((line, i) => `<a i=${i}>${line}</a>`);

    const response = await fetchApi(
      'https://translate-pa.googleapis.com/v1/translateHtml',
      {
        'credentials': 'omit',
        'headers': {
          'content-type': 'application/json+protobuf',
          'X-Goog-API-Key': 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520',
        },
        'referrer': 'https://wtr-lab.com/',
        'body': `[[${JSON.stringify(contained)},"zh-CN","es"],"te_lib"]`,
        'method': 'POST',
      },
    );
    const translated = await response.json();
    const out = translated && translated[0] ? translated[0] : [];
    return out as string[];
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = this.site + chapterPath;
    let rawId: number | null = null;
    let chapterNo: number | null = null;
    let loadedCheerio = null;

    const urlMatch = chapterPath.match(
      /(?:serie|novel)-?(\d+)\/[^/]+\/chapter-(\d+)/,
    );
    if (urlMatch) {
      rawId = parseInt(urlMatch[1], 10);
      chapterNo = parseInt(urlMatch[2], 10);
    }

    if (!rawId || !chapterNo) {
      const body = await fetchApi(url).then(res => res.text());

      loadedCheerio = parseHTML(body);
      const chapterJson = loadedCheerio('#__NEXT_DATA__').html() + '';
      const jsonData: NovelJson = JSON.parse(chapterJson);

      rawId = jsonData.props.pageProps.serie.chapter.raw_id;
      chapterNo = jsonData.props.pageProps.serie.chapter.order;
    }

    if (!rawId || !chapterNo) {
      const errorMsg = `Parámetros requeridos ausentes para la llamada a la API desde la URL '${chapterPath}' - rawId: ${rawId}, chapterNo: ${chapterNo}. Por favor verifica el formato de la URL.`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    const translationTypes = ['ai', 'web'];

    let eLog = '';
    let parsedJson;

    for (const type of translationTypes) {
      const apiResponse = await fetchApi(`${this.site}api/reader/get`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        referrer: url,
        body: JSON.stringify({
          translate: type,
          language: this.sourceLang.replace('/', ''),
          raw_id: rawId,
          chapter_no: chapterNo,
          retry: false,
          force_retry: false,
        }),
      });

      parsedJson = await apiResponse.json();
      if (!apiResponse.ok) {
        if (parsedJson.error) {
          eLog = parsedJson.error;
          continue;
        }
      } else if (!parsedJson.error) {
        break;
      }
    }
    if (parsedJson.success == false) {
      const errorMsg = parsedJson.message;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
    let chapterContent = parsedJson.data.data.body;
    const chapterGlossary: ChapterContent['glossary_data'] | undefined =
      parsedJson?.data?.data?.glossary_data;

    let htmlString = '';

    if (
      chapterContent.toString().startsWith('arr:') ||
      chapterContent.toString().startsWith('str:')
    ) {
      if (!loadedCheerio) {
        const body = await fetchApi(url).then(res => res.text());

        loadedCheerio = parseHTML(body);
      }
      const encKey = await this.getKey(loadedCheerio);
      chapterContent = await this.decrypt(chapterContent, encKey);
      if (Object.prototype.hasOwnProperty.call(chapterContent, 'error')) {
        htmlString += `<p>${chapterContent.error.toString()}</p>`;
        return htmlString;
      }
      chapterContent = await this.translate(chapterContent);
      htmlString += `<p><small>Este contenido está siendo traducido desde tu dispositivo a través de Google Translate. Inicia sesión vía Web View para intentar traducciones con IA.</small></p>`;
    }

    if (eLog !== '') {
      htmlString += `<p style="color:darkred;">${eLog}</p>`;
    }

    const dictionary = chapterGlossary?.terms?.map(t => t[0]) || [];

    for (let text of chapterContent) {
      if (dictionary.length > 0) {
        text = text.replaceAll(
          /(?:wtr-lab\s+)?※([0-9]+)[⛬〓]/g,
          (m: string, index: string) => dictionary[parseInt(index)] || m,
        );
      }
      htmlString += `<p>${text}</p>`;
    }

    return htmlString;
  }

  async fetchAllChapters(
    rawId: number,
    slug: string,
  ): Promise<Plugin.ChapterItem[]> {
    const allChapters: Plugin.ChapterItem[] = [];
    const batchSize = 500;
    let start = 1;
    let hasMore = true;

    while (hasMore) {
      const end = start + batchSize - 1;

      try {
        const response = await fetchApi(
          `${this.site}api/chapters/${rawId}?start=${start}&end=${end}`,
          {
            headers: {
              ...this.headers,
            },
          },
        );

        const data = await response.json();
        const chapters = data.chapters ?? data.data?.chapters ?? [];

        if (!Array.isArray(chapters) || chapters.length === 0) {
          hasMore = false;
          break;
        }

        const batchChapters: Plugin.ChapterItem[] = chapters.map(
          (apiChapter: ApiChapter) => ({
            name:
              apiChapter.title ||
              apiChapter.name ||
              `Capítulo ${apiChapter.order}`,
            path: `${this.sourceLang}serie-${rawId}/${slug}/chapter-${apiChapter.order}`,
            releaseTime: apiChapter.updated_at?.substring(0, 10),
            chapterNumber: apiChapter.order,
          }),
        );

        allChapters.push(...batchChapters);

        if (chapters.length < batchSize) {
          hasMore = false;
          break;
        }

        start += batchSize;
      } catch (error) {
        console.error(`Error al obtener capítulos ${start}-${end}:`, error);
        hasMore = false;
        break;
      }
    }

    return allChapters.sort(
      (a, b) => (a.chapterNumber || 0) - (b.chapterNumber || 0),
    );
  }

  async searchNovels(
    searchTerm: string,
    page: number,
  ): Promise<Plugin.NovelItem[]> {
    const filters = this.filters;
    filters.search.value = searchTerm;
    return this.popularNovels(page, { showLatestNovels: false, filters });
  }

  filters = {
    search: {
      value: '',
      label: 'Buscar',
      type: FilterTypes.TextInput,
    },
    orderBy: {
      value: 'update',
      label: 'Ordenar por',
      options: [
        { label: 'Fecha de actualización', value: 'update' },
        { label: 'Fecha de incorporación', value: 'date' },
        { label: 'Aleatorio', value: 'random' },
        { label: 'Visitas semanales', value: 'weekly_rank' },
        { label: 'Visitas mensuales', value: 'monthly_rank' },
        { label: 'Visitas totales', value: 'view' },
        { label: 'Nombre', value: 'name' },
        { label: 'Lectores', value: 'reader' },
        { label: 'Capítulos', value: 'chapter' },
        { label: 'Puntuación', value: 'rating' },
        { label: 'Número de reseñas', value: 'total_rate' },
        { label: 'Número de votos', value: 'vote' },
      ],
      type: FilterTypes.Picker,
    },
    order: {
      value: 'desc',
      label: 'Orden',
      options: [
        { label: 'Descendente', value: 'desc' },
        { label: 'Ascendente', value: 'asc' },
      ],
      type: FilterTypes.Picker,
    },
    status: {
      value: 'all',
      label: 'Estado',
      options: [
        { label: 'Todos', value: 'all' },
        { label: 'En emisión', value: 'ongoing' },
        { label: 'Completado', value: 'completed' },
        { label: 'En pausa', value: 'hiatus' },
        { label: 'Cancelado', value: 'dropped' },
      ],
      type: FilterTypes.Picker,
    },
    release_status: {
      value: 'all',
      label: 'Estado de publicación',
      options: [
        { label: 'Todos', value: 'all' },
        { label: 'Publicado', value: 'released' },
        { label: 'En votación', value: 'voting' },
      ],
      type: FilterTypes.Picker,
    },
    addition_age: {
      value: 'all',
      label: 'Antigüedad de adición',
      options: [
        { label: 'Todos', value: 'all' },
        { label: '< 2 Días', value: 'day' },
        { label: '< 1 Semana', value: 'week' },
        { label: '< 1 Mes', value: 'month' },
      ],
      type: FilterTypes.Picker,
    },
    min_chapters: {
      value: '',
      label: 'Mínimo de capítulos',
      type: FilterTypes.TextInput,
    },
    min_rating: {
      value: '',
      label: 'Puntuación mínima (0.0-5.0)',
      type: FilterTypes.TextInput,
    },
    min_review_count: {
      value: '',
      label: 'Mínimo de reseñas',
      type: FilterTypes.TextInput,
    },
    genre_operator: {
      value: 'and',
      label: 'Géneros (Y/O)',
      options: [
        { label: 'Y (And)', value: 'and' },
        { label: 'O (Or)', value: 'or' },
      ],
      type: FilterTypes.Picker,
    },
    genres: {
      label: 'Géneros',
      type: FilterTypes.ExcludableCheckboxGroup,
      value: { include: [], exclude: [] },
      options: [
        { label: 'Acción', value: 'action' },
        { label: 'Adulto', value: 'adult' },
        { label: 'Aventura', value: 'adventure' },
        { label: 'Comedia', value: 'comedy' },
        { label: 'Drama', value: 'drama' },
        { label: 'Ecchi', value: 'ecchi' },
        { label: 'Erciyuan', value: 'erciyuan' },
        { label: 'Fan-Fiction', value: 'fan-fiction' },
        { label: 'Fantasía', value: 'fantasy' },
        { label: 'Juegos', value: 'game' },
        { label: 'Cambio de género', value: 'gender-bender' },
        { label: 'Harén', value: 'harem' },
        { label: 'Histórico', value: 'historical' },
        { label: 'Terror', value: 'horror' },
        { label: 'Josei', value: 'josei' },
        { label: 'Artes Marciales', value: 'martial-arts' },
        { label: 'Maduro', value: 'mature' },
        { label: 'Mecha', value: 'mecha' },
        { label: 'Militar', value: 'military' },
        { label: 'Misterio', value: 'mystery' },
        { label: 'Psicológico', value: 'psychological' },
        { label: 'Romance', value: 'romance' },
        { label: 'Vida Escolar', value: 'school-life' },
        { label: 'Ciencia Ficción', value: 'sci-fi' },
        { label: 'Seinen', value: 'seinen' },
        { label: 'Shoujo', value: 'shoujo' },
        { label: 'Shoujo-Ai', value: 'shoujo-ai' },
        { label: 'Shounen', value: 'shounen' },
        { label: 'Shounen-Ai', value: 'shounen-ai' },
        { label: 'Recuentos de la vida', value: 'slice-of-life' },
        { label: 'Smut', value: 'smut' },
        { label: 'Deportes', value: 'sports' },
        { label: 'Sobrenatural', value: 'supernatural' },
        { label: 'Tragedia', value: 'tragedy' },
        { label: 'Vida Urbana', value: 'urban-life' },
        { label: 'Wuxia', value: 'wuxia' },
        { label: 'Xianxia', value: 'xianxia' },
        { label: 'Xuanhuan', value: 'xuanhuan' },
        { label: 'Yaoi', value: 'yaoi' },
        { label: 'Yuri', value: 'yuri' },
      ],
    },
    tag_operator: {
      value: 'and',
      label: 'Etiquetas (Y/O)',
      options: [
        { label: 'Y (And)', value: 'and' },
        { label: 'O (Or)', value: 'or' },
      ],
      type: FilterTypes.Picker,
    },

    tags: {
      label: 'Etiquetas',
      type: FilterTypes.ExcludableCheckboxGroup,
      value: {
        include: [],
        exclude: [],
      },
      options: [
        { label: 'Niños abandonados', value: '1' },
        { label: 'Robo de habilidades', value: '2' },
        { label: 'Padres ausentes', value: '3' },
        { label: 'Personajes abusivos', value: '4' },
        { label: 'Academia', value: '5' },
        { label: 'Crecimiento acelerado', value: '6' },
        { label: 'Actuación', value: '7' },
        { label: 'Adaptado del manga', value: '8' },
        { label: 'Adaptado del manhua', value: '9' },
        { label: 'Adaptado al anime', value: '10' },
        { label: 'Adaptado a drama', value: '11' },
        { label: 'Adaptado a Drama CD', value: '12' },
        { label: 'Adaptado a juego', value: '13' },
        { label: 'Adaptado al manga', value: '14' },
        { label: 'Adaptado al manhua', value: '15' },
        { label: 'Adaptado al manhwa', value: '16' },
        { label: 'Adaptado a película', value: '17' },
        { label: 'Adaptado a novela visual', value: '18' },
        { label: 'Niños adoptados', value: '19' },
        { label: 'Protagonista adoptado', value: '20' },
        { label: 'Adulterio', value: '21' },
        { label: 'Aventureros', value: '22' },
        { label: 'Aventura amorosa', value: '23' },
        { label: 'Progresión de edad', value: '24' },
        { label: 'Regresión de edad', value: '25' },
        { label: 'Personajes agresivos', value: '26' },
        { label: 'Alquimia', value: '27' },
        { label: 'Extraterrestres', value: '28' },
        { label: 'Escuela para chicas', value: '29' },
        { label: 'Mundo alternativo', value: '30' },
        { label: 'Amnesia', value: '31' },
        { label: 'Parque de atracciones', value: '32' },
        { label: 'Anal', value: '33' },
        { label: 'Antigua China', value: '34' },
        { label: 'Tiempos antiguos', value: '35' },
        { label: 'Personajes andróginos', value: '36' },
        { label: 'Androides', value: '37' },
        { label: 'Ángeles', value: '38' },
        { label: 'Características animales', value: '39' },
        { label: 'Cría de animales', value: '40' },
        { label: 'Anti-magia', value: '41' },
        { label: 'Protagonista antisocial', value: '42' },
        { label: 'Protagonista antihéroe', value: '43' },
        { label: 'Tienda de antigüedades', value: '44' },
        { label: 'Vida de apartamento', value: '45' },
        { label: 'Protagonista apático', value: '46' },
        { label: 'Apocalipsis', value: '47' },
        { label: 'Cambios de apariencia', value: '48' },
        { label: 'Apariencia diferente a la edad real', value: '49' },
        { label: 'Tiro con arco', value: '50' },
        { label: 'Aristocracia', value: '51' },
        { label: 'Traficantes de armas', value: '52' },
        { label: 'Ejército', value: '53' },
        { label: 'Construcción de ejércitos', value: '54' },
        { label: 'Matrimonio arreglado', value: '55' },
        { label: 'Formaciones/Matrices', value: '822' },
        { label: 'Personajes arrogantes', value: '56' },
        { label: 'Creación de artefactos', value: '57' },
        { label: 'Artefactos', value: '58' },
        { label: 'Inteligencia artificial', value: '59' },
        { label: 'Artistas', value: '60' },
        { label: 'Asesinos', value: '61' },
        { label: 'Astrólogos', value: '62' },
        { label: 'Autismo', value: '63' },
        { label: 'Autómatas', value: '64' },
        { label: 'Protagonista de apariencia común', value: '65' },
        { label: 'Obra premiada', value: '66' },
        { label: 'Protagonista torpe', value: '67' },
        { label: 'Bandas de música', value: '68' },
        { label: 'Basado en una película', value: '69' },
        { label: 'Basado en una canción', value: '70' },
        { label: 'Basado en un programa de TV', value: '71' },
        { label: 'Basado en un videojuego', value: '72' },
        { label: 'Basado en una novela visual', value: '73' },
        { label: 'Basado en un anime', value: '74' },
        { label: 'Baloncesto', value: '809' },
        { label: 'Academia de batalla', value: '75' },
        { label: 'Competencia de batalla', value: '76' },
        { label: 'BDSM', value: '77' },
        { label: 'Compañeros bestia', value: '78' },
        { label: 'Hombre bestia', value: '79' },
        { label: 'Bestias', value: '80' },
        { label: 'Protagonista femenina hermosa', value: '81' },
        { label: 'Bestialismo', value: '82' },
        { label: 'Traición', value: '83' },
        { label: 'Pareja conflictiva', value: '84' },
        { label: 'Biochip', value: '85' },
        { label: 'Protagonista bisexual', value: '86' },
        { label: 'Mente oscura / Astuto', value: '87' },
        { label: 'Chantaje', value: '88' },
        { label: 'Herrero', value: '89' },
        { label: 'Bleach', value: '770' },
        { label: 'Citas a ciegas', value: '90' },
        { label: 'Protagonista ciego', value: '91' },
        { label: 'Manipulación de sangre', value: '92' },
        { label: 'Líneas de sangre', value: '93' },
        { label: 'Intercambio de cuerpos', value: '94' },
        { label: 'Templado corporal', value: '95' },
        { label: 'Doble de cuerpo', value: '96' },
        { label: 'Guardaespaldas', value: '97' },
        { label: 'Libros', value: '98' },
        { label: 'Ratón de biblioteca', value: '99' },
        { label: 'Relación jefe-subordinado', value: '100' },
        { label: 'Lavado de cerebro', value: '101' },
        { label: 'Fetichismo de pechos', value: '102' },
        { label: 'Compromiso roto', value: '103' },
        { label: 'Complejo de hermano', value: '104' },
        { label: 'Hermandad', value: '105' },
        { label: 'Budismo', value: '106' },
        { label: 'Acoso escolar / Bullying', value: '107' },
        { label: 'Gestión empresarial', value: '108' },
        { label: 'Guerra comercial', value: '806' },
        { label: 'Empresarios', value: '109' },
        { label: 'Mayordomos', value: '110' },
        { label: 'Protagonista tranquilo', value: '111' },
        { label: 'Canibalismo', value: '112' },
        { label: 'Juegos de cartas', value: '113' },
        { label: 'Protagonista despreocupado', value: '114' },
        { label: 'Protagonista atento', value: '115' },
        { label: 'Protagonista precavido', value: '116' },
        { label: 'Celebridades', value: '117' },
        { label: 'Crecimiento del personaje', value: '118' },
        { label: 'Protagonista carismático', value: '119' },
        { label: 'Protagonista encantador', value: '120' },
        { label: 'Salas de chat', value: '121' },
        { label: 'Trucos / Cheats', value: '122' },
        { label: 'Chefs', value: '123' },
        { label: 'Maltrato infantil', value: '124' },
        { label: 'Protagonista infantil', value: '125' },
        { label: 'Cuidado de niños', value: '126' },
        { label: 'Amigos de la infancia', value: '127' },
        { label: 'Amor de la infancia', value: '128' },
        { label: 'Promesa de la infancia', value: '129' },
        { label: 'Protagonista infantil', value: '130' },
        { label: 'Chuunibyou', value: '131' },
        { label: 'Construcción de clanes', value: '132' },
        { label: 'Despertar de clase', value: '827' },
        { label: 'Clásico', value: '133' },
        { label: 'Protagonista inteligente', value: '134' },
        { label: 'Amante pegajoso', value: '135' },
        { label: 'Clones', value: '136' },
        { label: 'Clubes', value: '137' },
        { label: 'Intereses amorosos torpes', value: '138' },
        { label: 'Compañeros de trabajo', value: '139' },
        { label: 'Cohabitaciòn', value: '140' },
        { label: 'Intereses amorosos fríos', value: '141' },
        { label: 'Protagonista frío', value: '142' },
        { label: 'Colección de historias cortas', value: '143' },
        { label: 'Universidad', value: '144' },
        { label: 'Coma', value: '145' },
        { label: 'Tono cómico', value: '146' },
        { label: 'Transición a la madurez', value: '147' },
        { label: 'Relaciones familiares complejas', value: '148' },
        { label: 'Poder condicional', value: '149' },
        { label: 'Dioses conferidos', value: '800' },
        { label: 'Protagonista seguro de sí mismo', value: '150' },
        { label: 'Confinamiento', value: '151' },
        { label: 'Lealtades en conflicto', value: '152' },
        { label: 'Contratos', value: '153' },
        { label: 'Cocina', value: '154' },
        { label: 'Copia', value: '807' },
        { label: 'Corrupción', value: '155' },
        { label: 'Guerras cósmicas', value: '156' },
        { label: 'Cosplay', value: '157' },
        { label: 'Crecimiento en pareja', value: '158' },
        { label: 'Oficial de la corte', value: '159' },
        { label: 'Primos', value: '160' },
        { label: 'Protagonista cobarde', value: '161' },
        { label: 'Artesanía / Crafting', value: '162' },
        { label: 'Crimen', value: '163' },
        { label: 'Criminales', value: '164' },
        { label: 'Travestismo', value: '165' },
        { label: 'Crossover', value: '166' },
        { label: 'Personajes crueles', value: '167' },
        { label: 'Criogenia', value: '168' },
        { label: 'Cultivo', value: '169' },
        { label: 'Cunnilingus', value: '170' },
        { label: 'Protagonista astuto', value: '171' },
        { label: 'Protagonista curioso', value: '172' },
        { label: 'Maldiciones', value: '173' },
        { label: 'Niños tiernos', value: '174' },
        { label: 'Protagonista tierno', value: '175' },
        { label: 'Historia tierna', value: '176' },
        { label: 'Cyberpunk 2077', value: '783' },
        { label: 'Bailarines', value: '177' },
        { label: 'Compañero Dao', value: '178' },
        { label: 'Comprensión del Dao', value: '179' },
        { label: 'Taoísmo', value: '180' },
        { label: 'Oscuro', value: '181' },
        { label: 'Fantasía oscura', value: '789' },
        { label: 'Universo DC', value: '778' },
        { label: 'Protagonista muerto', value: '182' },
        { label: 'Muerte', value: '183' },
        { label: 'Muerte de seres queridos', value: '184' },
        { label: 'Deudas', value: '185' },
        { label: 'Delincuentes', value: '186' },
        { label: 'Delirios', value: '187' },
        { label: 'Semihumanos', value: '188' },
        { label: 'Rey Demonio', value: '189' },
        { label: 'Demon Slayer', value: '812' },
        { label: 'Técnica de cultivo demoníaca', value: '190' },
        { label: 'Demonios', value: '191' },
        { label: 'Protagonista despistado', value: '192' },
        { label: 'Representaciones de crueldad', value: '193' },
        { label: 'Depresión', value: '194' },
        { label: 'Destino', value: '195' },
        { label: 'Detective Conan', value: '804' },
        { label: 'Detectives', value: '196' },
        { label: 'Protagonista determinado', value: '197' },
        { label: 'Intereses amorosos devotos', value: '198' },
        { label: 'Devoración', value: '797' },
        { label: 'Diferente estatus social', value: '199' },
        { label: 'Discapacidades', value: '200' },
        { label: 'Discriminación', value: '201' },
        { label: 'Desfiguración', value: '202' },
        { label: 'Protagonista deshonesto', value: '203' },
        { label: 'Protagonista desconfiado', value: '204' },
        { label: 'Adivinación', value: '205' },
        { label: 'Protección divina', value: '206' },
        { label: 'Divorcio', value: '207' },
        { label: 'DnD (Dragones y Mazmorras)', value: '794' },
        { label: 'Médicos', value: '208' },
        { label: 'Muñecos / Marionetas', value: '209' },
        { label: 'Asuntos domésticos', value: '210' },
        { label: 'Intereses amorosos consentidores', value: '211' },
        { label: 'Hermanos mayores consentidores', value: '212' },
        { label: 'Padres consentidores', value: '213' },
        { label: 'Douluo Dalu', value: '772' },
        { label: 'Dragon Ball', value: '773' },
        { label: 'Jinetes de dragón', value: '214' },
        { label: 'Cazadores de dragones', value: '215' },
        { label: 'Dragones', value: '216' },
        { label: 'Sueños', value: '217' },
        { label: 'Drogas', value: '218' },
        { label: 'Druidas', value: '219' },
        { label: 'Amo de la mazmorra', value: '220' },
        { label: 'Mazmorras', value: '221' },
        { label: 'Enanos', value: '222' },
        { label: 'Distopía', value: '223' },
        { label: 'Deportes electrónicos', value: '224' },
        { label: 'Romance temprano', value: '225' },
        { label: 'Invasión de la Tierra', value: '226' },
        { label: 'Vida tranquila', value: '227' },
        { label: 'Escuchas telefónicas / Espionaje', value: '798' },
        { label: 'Economía', value: '228' },
        { label: 'Editores', value: '229' },
        { label: 'Memoria fotográfica', value: '230' },
        { label: 'Protagonista anciano', value: '231' },
        { label: 'Magia elemental', value: '232' },
        { label: 'Elfos', value: '233' },
        { label: 'Protagonista emocionalmente débil', value: '234' },
        { label: 'Imperios', value: '235' },
        { label: 'Enemigos se vuelven aliados', value: '236' },
        { label: 'Enemigos se convierten en amantes', value: '237' },
        { label: 'Compromiso matrimonial', value: '238' },
        { label: 'Ingeniero', value: '239' },
        { label: 'Iluminación / Enlightenment', value: '240' },
        { label: 'Episódico', value: '241' },
        { label: 'Eunuco', value: '242' },
        { label: 'Ambiente europeo', value: '243' },
        { label: 'Dioses malvados', value: '244' },
        { label: 'Organizaciones malvadas', value: '245' },
        { label: 'Protagonista malvado', value: '246' },
        { label: 'Religiones malvadas', value: '247' },
        { label: 'Evolución', value: '248' },
        { label: 'Exhibicionismo', value: '249' },
        { label: 'Exorcismo', value: '250' },
        { label: 'Poderes oculares', value: '251' },
        { label: 'Hadas', value: '252' },
        { label: 'Fairy Tail', value: '814' },
        { label: 'Deidades dependientes de la fe', value: '808' },
        { label: 'Ángeles caídos', value: '253' },
        { label: 'Nobleza caída', value: '254' },
        { label: 'Amor familiar', value: '255' },
        { label: 'Familiares', value: '256' },
        { label: 'Familia', value: '257' },
        { label: 'Negocio familiar', value: '258' },
        { label: 'Conflicto familiar', value: '259' },
        { label: 'Padres famosos', value: '260' },
        { label: 'Protagonista famoso', value: '261' },
        { label: 'Fanatismo', value: '262' },
        { label: 'Fanfiction', value: '263' },
        { label: 'Criaturas fantásticas', value: '264' },
        { label: 'Mundo fantástico', value: '265' },
        { label: 'Agricultura', value: '266' },
        { label: 'Cultivo rápido', value: '267' },
        { label: 'Aprendiz rápido', value: '268' },
        { label: 'Protagonista gordo', value: '269' },
        { label: 'De gordo a esbelto', value: '270' },
        { label: 'Amantes destinados', value: '271' },
        { label: 'Protagonista intrépido', value: '272' },
        { label: 'Felación', value: '273' },
        { label: 'Maestra femenina', value: '274' },
        { label: 'Protagonista femenina', value: '275' },
        { label: 'De mujer a hombre', value: '276' },
        { label: 'Feng Shui', value: '277' },
        { label: 'Armas de fuego', value: '278' },
        { label: 'Primer amor', value: '279' },
        { label: 'Primera relación sexual', value: '280' },
        { label: 'Flashbacks', value: '281' },
        { label: 'Batallas navales', value: '282' },
        { label: 'Folclore', value: '283' },
        { label: 'Fútbol', value: '780' },
        { label: 'Forzado a una relación', value: '284' },
        { label: 'Convivencia forzada', value: '285' },
        { label: 'Matrimonio forzado', value: '286' },
        { label: 'Protagonista olvidadizo', value: '287' },
        { label: 'Antiguo héroe', value: '288' },
        { label: 'Espíritus zorro', value: '289' },
        { label: 'Amigos se vuelven enemigos', value: '290' },
        { label: 'Amistad', value: '291' },
        { label: 'Frieren', value: '816' },
        { label: 'Fujoshi', value: '292' },
        { label: 'Futanari', value: '293' },
        { label: 'Ambientación futurista', value: '294' },
        { label: 'Galge', value: '295' },
        { label: 'Juegos de azar', value: '296' },
        { label: 'Creador de juegos', value: '784' },
        { label: 'Elementos de juego', value: '297' },
        { label: 'Juego de Tronos', value: '813' },
        { label: 'Sistema de clasificación de juego', value: '298' },
        { label: 'Jugadores / Gamers', value: '299' },
        { label: 'Pandillas', value: '300' },
        { label: 'Gao Wu', value: '781' },
        { label: 'Puerta a otro mundo', value: '301' },
        { label: 'Protagonista sin género', value: '302' },
        { label: 'Generales', value: '303' },
        { label: 'Modificaciones genéticas', value: '304' },
        { label: 'Genios / Genios de la lámpara', value: '305' },
        { label: 'Protagonista genio', value: '306' },
        { label: 'Genshin Impact', value: '815' },
        { label: 'Fantasmas', value: '307' },
        { label: 'Gladiadores', value: '308' },
        { label: 'Intereses amorosos con gafas', value: '309' },
        { label: 'Protagonista con gafas', value: '310' },
        { label: 'Goblins', value: '311' },
        { label: 'Protagonista Dios', value: '312' },
        { label: 'Relación dios-humano', value: '313' },
        { label: 'Diosas', value: '314' },
        { label: 'Poderes divinos', value: '315' },
        { label: 'Dioses', value: '316' },
        { label: 'Gólems', value: '317' },
        { label: 'Sangriento / Gore', value: '318' },
        { label: 'Guardianes de tumbas', value: '319' },
        { label: 'Grind / Progreso repetitivo', value: '320' },
        { label: 'Relación de tutoría', value: '321' },
        { label: 'Gremios', value: '322' },
        { label: 'Pistoleros', value: '323' },
        { label: 'Hackers', value: '324' },
        { label: 'Protagonista semihumano', value: '325' },
        { label: 'Masturbación manual / Handjob', value: '326' },
        { label: 'Protagonista masculino atractivo', value: '327' },
        { label: 'Protagonista trabajador', value: '328' },
        { label: 'Protagonista en busca de harén', value: '329' },
        { label: 'Harry Potter', value: '768' },
        { label: 'Entrenamiento duro', value: '330' },
        { label: 'Protagonista odiado', value: '331' },
        { label: 'Curanderos', value: '332' },
        { label: 'Conmovedor', value: '333' },
        { label: 'Cielo', value: '334' },
        { label: 'Comprensión celestial', value: '803' },
        { label: 'Tribulación celestial', value: '335' },
        { label: 'Infierno', value: '336' },
        { label: 'Protagonista servicial', value: '337' },
        { label: 'Herbolario', value: '338' },
        { label: 'Héroes', value: '339' },
        { label: 'Heterocromía', value: '340' },
        { label: 'Habilidades ocultas', value: '341' },
        { label: 'Oculta sus verdaderas habilidades', value: '342' },
        { label: 'Oculta su verdadera identidad', value: '343' },
        { label: 'Hikikomori', value: '344' },
        { label: 'Hollywood', value: '779' },
        { label: 'Homúnculo', value: '345' },
        { label: 'Protagonista honesto', value: '346' },
        { label: 'Hong Kong', value: '821' },
        { label: 'Honghuang', value: '801' },
        { label: 'Honkai', value: '818' },
        { label: 'Hospital', value: '347' },
        { label: 'Protagonista apasionado', value: '348' },
        { label: 'Experimentación humana', value: '349' },
        { label: 'Arma humana', value: '350' },
        { label: 'Relación humano-no humano', value: '351' },
        { label: 'Protagonista humanoide', value: '352' },
        { label: 'Hunter x Hunter', value: '777' },
        { label: 'Cazadores', value: '353' },
        { label: 'Hipnosis', value: '354' },
        { label: 'Crisis de identidad', value: '355' },
        { label: 'Amigo imaginario', value: '356' },
        { label: 'Inmortales', value: '357' },
        { label: 'Harén imperial', value: '358' },
        { label: 'Incesto', value: '359' },
        { label: 'Íncubo', value: '360' },
        { label: 'Protagonista indeciso', value: '361' },
        { label: 'Industrialización', value: '362' },
        { label: 'Complejo de inferioridad', value: '363' },
        { label: 'Herencia', value: '364' },
        { label: 'Inscripciones', value: '365' },
        { label: 'Insectos', value: '366' },
        { label: 'Historias interconectadas', value: '367' },
        { label: 'Viaje interdimensional', value: '368' },
        { label: 'Protagonista introvertido', value: '369' },
        { label: 'Investigaciones', value: '370' },
        { label: 'Invisibilidad', value: '371' },
        { label: 'Todoterreno / Jack of all trades', value: '372' },
        { label: 'Celos', value: '373' },
        { label: 'Jiangshi', value: '374' },
        { label: 'Clase desempleada', value: '375' },
        { label: 'Viaje al Oeste', value: '796' },
        { label: 'JSDF (Fuerzas de Autodefensa)', value: '376' },
        { label: 'Jujutsu Kaisen', value: '776' },
        { label: 'Secuestros', value: '377' },
        { label: 'Kimetsu no Yaiba', value: '805' },
        { label: 'Intereses amorosos amables', value: '378' },
        { label: 'Construcción de reinos', value: '379' },
        { label: 'Reinos', value: '380' },
        { label: 'Caballeros', value: '381' },
        { label: 'Kuudere', value: '382' },
        { label: 'Falta de sentido común', value: '383' },
        { label: 'Barrera del idioma', value: '384' },
        { label: 'Romance tardío', value: '385' },
        { label: 'Abogados', value: '386' },
        { label: 'Protagonista perezoso', value: '387' },
        { label: 'Liderazgo', value: '388' },
        { label: 'League of Legends', value: '791' },
        { label: 'Leyendas', value: '389' },
        { label: 'Sistema de niveles', value: '390' },
        { label: 'Biblioteca', value: '391' },
        { label: 'Guión de vida', value: '824' },
        { label: 'Esperanza de vida limitada', value: '392' },
        { label: 'Transmisión en vivo', value: '782' },
        { label: 'Vivir en el extranjero', value: '393' },
        { label: 'Vivir solo', value: '394' },
        { label: 'Loli', value: '395' },
        { label: 'Soledad', value: '396' },
        { label: 'Protagonista solitario', value: '397' },
        { label: 'Largas separaciones', value: '398' },
        { label: 'Relación a distancia', value: '399' },
        { label: 'Señor feudal / Lord', value: '823' },
        { label: 'Lord of the Mysteries', value: '799' },
        { label: 'Civilizaciones perdidas', value: '400' },
        { label: 'Lotería', value: '401' },
        { label: 'Amor a primera vista', value: '402' },
        { label: 'El interés amoroso se enamora primero', value: '403' },
        { label: 'Rivales de amor', value: '404' },
        { label: 'Triángulos amorosos', value: '405' },
        { label: 'Reencuentro de amantes', value: '406' },
        { label: 'Protagonista de perfil bajo', value: '407' },
        { label: 'Subordinados leales', value: '408' },
        { label: 'Protagonista afortunado', value: '409' },
        { label: 'Magia', value: '410' },
        { label: 'Bestias mágicas', value: '411' },
        { label: 'Formaciones mágicas', value: '412' },
        { label: 'Chicas mágicas', value: '413' },
        { label: 'Espacio mágico', value: '414' },
        { label: 'Tecnología mágica', value: '415' },
        { label: 'Sirvientas / Maids', value: '416' },
        { label: 'Protagonista masculino', value: '417' },
        { label: 'De hombre a mujer', value: '418' },
        { label: 'Yandere masculino', value: '419' },
        { label: 'Gestión', value: '420' },
        { label: 'Mangaka', value: '421' },
        { label: 'Personajes manipuladores', value: '422' },
        { label: 'Pareja gay varonil', value: '423' },
        { label: 'Matrimonio', value: '424' },
        { label: 'Matrimonio de conveniencia', value: '425' },
        { label: 'Espíritus marciales', value: '426' },
        { label: 'Marvel', value: '766' },
        { label: 'Personajes masoquistas', value: '427' },
        { label: 'Relación maestro-discípulo', value: '428' },
        { label: 'Relación amo-sirviente', value: '429' },
        { label: 'Masturbación', value: '430' },
        { label: 'Matriarcado', value: '431' },
        { label: 'Protagonista maduro', value: '432' },
        { label: 'Conocimiento médico', value: '433' },
        { label: 'Medieval', value: '434' },
        { label: 'Mercenarios', value: '435' },
        { label: 'Comerciantes', value: '436' },
        { label: 'Militar', value: '437' },
        { label: 'Quiebre mental', value: '438' },
        { label: 'Control mental', value: '439' },
        { label: 'Minecraft', value: '790' },
        { label: 'Misandria', value: '440' },
        { label: 'Pareja dispareja', value: '441' },
        { label: 'Malentendidos', value: '442' },
        { label: 'MMORPG', value: '443' },
        { label: 'Protagonista secundario / Mob', value: '444' },
        { label: 'Modelos', value: '445' },
        { label: 'Época moderna', value: '446' },
        { label: 'Conocimiento moderno', value: '447' },
        { label: 'Codicioso', value: '448' },
        { label: 'Chicas monstruo', value: '449' },
        { label: 'Sociedad de monstruos', value: '450' },
        { label: 'Domador de monstruos', value: '451' },
        { label: 'Monstruos', value: '452' },
        { label: 'Más hijos más bendiciones', value: '825' },
        { label: 'Flujo mortal', value: '792' },
        { label: 'Películas', value: '453' },
        { label: 'Embarazo masculino', value: '454' },
        { label: 'Identidades múltiples', value: '455' },
        { label: 'Personalidades múltiples', value: '456' },
        { label: 'Múltiples puntos de vista', value: '457' },
        { label: 'Múltiples protagonistas', value: '458' },
        { label: 'Múltiples reinos', value: '459' },
        { label: 'Múltiples personas reencarnadas', value: '460' },
        { label: 'Líneas temporales múltiples', value: '461' },
        { label: 'Múltiples personas transportadas', value: '462' },
        { label: 'Asesinatos', value: '463' },
        { label: 'Música', value: '464' },
        { label: 'Criaturas mutantes', value: '465' },
        { label: 'Mutaciones', value: '466' },
        { label: 'Personaje mudo', value: '467' },
        { label: 'Misterioso origen familiar', value: '468' },
        { label: 'Enfermedad misteriosa', value: '469' },
        { label: 'Pasado misterioso', value: '470' },
        { label: 'Resolución de misterios', value: '471' },
        { label: 'Bestias míticas', value: '472' },
        { label: 'Mitología', value: '473' },
        { label: 'Protagonista ingenuo', value: '474' },
        { label: 'Protagonista narcisista', value: '475' },
        { label: 'Naruto', value: '769' },
        { label: 'Nacionalismo', value: '476' },
        { label: 'Experiencia cercana a la muerte', value: '477' },
        { label: 'Nigromante', value: '478' },
        { label: 'Neet', value: '479' },
        { label: 'Netorare', value: '480' },
        { label: 'Netorase', value: '481' },
        { label: 'Netori', value: '482' },
        { label: 'Pesadillas', value: '483' },
        { label: 'Ninjas', value: '484' },
        { label: 'Nobles', value: '485' },
        { label: 'Protagonista no humanoide', value: '486' },
        { label: 'Narración no lineal', value: '487' },
        { label: 'Desnudez', value: '488' },
        { label: 'Enfermeras', value: '489' },
        { label: 'Amor obsesivo', value: '490' },
        { label: 'Romance de oficina', value: '491' },
        { label: 'Intereses amorosos mayores', value: '492' },
        { label: 'Omegaverse', value: '493' },
        { label: 'One Piece', value: '767' },
        { label: 'Capítulo único / Oneshot', value: '494' },
        { label: 'Romance en línea', value: '495' },
        { label: 'Onmyouji', value: '496' },
        { label: 'Orcos', value: '497' },
        { label: 'Crimen organizado', value: '498' },
        { label: 'Orpía', value: '499' },
        { label: 'Huérfanos', value: '500' },
        { label: 'Otaku', value: '501' },
        { label: 'Juego Otome', value: '502' },
        { label: 'Marginados', value: '503' },
        { label: 'Relaciones al aire libre', value: '504' },
        { label: 'Espacio exterior', value: '505' },
        { label: 'Overlord', value: '826' },
        { label: 'Protagonista todopoderoso', value: '506' },
        { label: 'Hermanos sobreprotectores', value: '507' },
        { label: 'Protagonista pacifista', value: '508' },
        { label: 'Paizuri', value: '509' },
        { label: 'Mundos paralelos', value: '510' },
        { label: 'Parásitos', value: '511' },
        { label: 'Complejo con los padres', value: '512' },
        { label: 'Parodia', value: '513' },
        { label: 'Trabajo de medio tiempo', value: '514' },
        { label: 'El pasado juega un gran papel', value: '515' },
        { label: 'Trauma pasado', value: '516' },
        { label: 'Intereses amorosos persistentes', value: '517' },
        { label: 'Cambios de personalidad', value: '518' },
        { label: 'Protagonista pervertido', value: '519' },
        { label: 'Mascotas', value: '520' },
        { label: 'Farmacéutico', value: '521' },
        { label: 'Filosófico', value: '522' },
        { label: 'Fobias', value: '523' },
        { label: 'Fénix', value: '524' },
        { label: 'Fotografía', value: '525' },
        { label: 'Cultivo basado en píldoras', value: '526' },
        { label: 'Elaboración de píldoras', value: '527' },
        { label: 'Pilotos', value: '528' },
        { label: 'Piratas', value: '529' },
        { label: 'Playboys', value: '530' },
        { label: 'Protagonista juguetón', value: '531' },
        { label: 'Poesía', value: '532' },
        { label: 'Venenos', value: '533' },
        { label: 'Pokémon', value: '771' },
        { label: 'Policía', value: '534' },
        { label: 'Protagonista educado', value: '535' },
        { label: 'Política', value: '536' },
        { label: 'Poliandria', value: '537' },
        { label: 'Poligamia', value: '538' },
        { label: 'Protagonista pobre', value: '539' },
        { label: 'De pobre a rico', value: '540' },
        { label: 'Intereses amorosos populares', value: '541' },
        { label: 'Posesión', value: '542' },
        { label: 'Personajes posesivos', value: '543' },
        { label: 'Postapocalíptico', value: '544' },
        { label: 'Pareja poderosa', value: '545' },
        { label: 'Lucha por el poder', value: '546' },
        { label: 'Protagonista pragmático', value: '547' },
        { label: 'Precognición', value: '548' },
        { label: 'Embarazo', value: '549' },
        { label: 'Falsos amantes', value: '550' },
        { label: 'Talento de vida anterior', value: '551' },
        { label: 'Sacerdotisas', value: '552' },
        { label: 'Sacerdotes', value: '553' },
        { label: 'Prisión', value: '554' },
        { label: 'Protagonista proactivo', value: '555' },
        { label: 'Dominio / Proficiencia', value: '793' },
        { label: 'Programador', value: '556' },
        { label: 'Profecías', value: '557' },
        { label: 'Prostitutas', value: '558' },
        { label: 'El protagonista se enamora primero', value: '559' },
        { label: 'Protagonista fuerte desde el principio', value: '560' },
        { label: 'Protagonista con múltiples cuerpos', value: '561' },
        { label: 'Poderes psíquicos', value: '562' },
        { label: 'Psicópatas', value: '563' },
        { label: 'Titiriteros', value: '564' },
        { label: 'Personajes tranquilos', value: '565' },
        { label: 'Personajes mefistofélicos / Peculiares', value: '566' },
        { label: 'R-15', value: '567' },
        { label: 'R-18', value: '568' },
        { label: 'Cambio de raza', value: '569' },
        { label: 'Racismo', value: '570' },
        { label: 'Violación', value: '571' },
        { label: 'Víctima de violación se vuelve amante', value: '572' },
        { label: 'Fusión de juego y realidad', value: '830' },
        { label: 'Rebelión', value: '573' },
        { label: 'Renacido', value: '829' },
        { label: 'Renacido como el villano', value: '831' },
        { label: 'Reencarnado como monstruo', value: '574' },
        { label: 'Reencarnado como un objeto', value: '575' },
        { label: 'Reencarnado en un mundo de juego', value: '576' },
        { label: 'Reencarnado en otro mundo', value: '577' },
        { label: 'Reencarnación', value: '578' },
        { label: 'Religiones', value: '579' },
        { label: 'Protagonista reacio', value: '580' },
        { label: 'Reporteros', value: '581' },
        { label: 'Restaurante', value: '582' },
        { label: 'Resurrección', value: '583' },
        { label: 'Regresando de otro mundo', value: '584' },
        { label: 'Venganza', value: '585' },
        { label: 'Harén inverso', value: '586' },
        { label: 'Violación inversa', value: '587' },
        { label: 'Pareja reversible', value: '588' },
        { label: 'De rico a pobre', value: '589' },
        { label: 'Protagonista justo', value: '590' },
        { label: 'Rivalidad', value: '591' },
        { label: 'Subtrama romántica', value: '592' },
        { label: 'Compañeros de cuarto', value: '593' },
        { label: 'Realeza', value: '594' },
        { label: 'Protagonista despiadado', value: '595' },
        { label: 'Personajes sádicos', value: '596' },
        { label: 'Santos / Santas', value: '597' },
        { label: 'Oficinista / Salaryman', value: '598' },
        { label: 'Samuráis', value: '599' },
        { label: 'Salvando al mundo', value: '600' },
        { label: 'Complot y conspiraciones', value: '601' },
        { label: 'Esquizofrenia', value: '602' },
        { label: 'Científicos', value: '603' },
        { label: 'Escultores', value: '604' },
        { label: 'Poder sellado', value: '605' },
        { label: 'Segunda oportunidad', value: '606' },
        { label: 'Amor secreto', value: '607' },
        { label: 'Identidad secreta', value: '608' },
        { label: 'Organizaciones secretas', value: '609' },
        { label: 'Relación secreta', value: '610' },
        { label: 'Protagonista reservado', value: '611' },
        { label: 'Secretos', value: '612' },
        { label: 'Desarrollo de secta', value: '613' },
        { label: 'Seducción', value: '614' },
        { label: 'Ve cosas que otros no ven', value: '615' },
        { label: 'Protagonista egoísta', value: '616' },
        { label: 'Protagonista abnegado', value: '617' },
        { label: 'Protagonista activo (Seme)', value: '618' },
        { label: 'Relación Senpai-Kouhai', value: '619' },
        { label: 'Objetos conscientes', value: '620' },
        { label: 'Protagonista sentimental', value: '621' },
        { label: 'Asesinos en serie', value: '622' },
        { label: 'Sirvientes', value: '623' },
        { label: 'Siete pecados capitales', value: '624' },
        { label: 'Siete virtudes', value: '625' },
        { label: 'Amigos con derechos', value: '626' },
        { label: 'Esclavos sexuales', value: '627' },
        { label: 'Abuso sexual', value: '628' },
        { label: 'Técnica de cultivo sexual', value: '629' },
        { label: 'Protagonista desvergonzado', value: '630' },
        { label: 'Metamorfos', value: '631' },
        { label: 'Compartiendo cuerpo', value: '632' },
        { label: 'Personajes de lengua afilada', value: '633' },
        { label: 'Usuario de escudo', value: '634' },
        { label: 'Shikigami', value: '635' },
        { label: 'Historia corta', value: '636' },
        { label: 'Shota', value: '637' },
        { label: 'Subtrama Shoujo-Ai', value: '638' },
        { label: 'Subtrama Shounen-Ai', value: '639' },
        { label: 'Mundo del espectáculo', value: '640' },
        { label: 'Personajes tímidos', value: '641' },
        { label: 'Rivalidad entre hermanos', value: '642' },
        { label: 'Cuidado de hermanos', value: '643' },
        { label: 'Hermanos', value: '644' },
        { label: 'Hermanos no sanguíneos', value: '645' },
        { label: 'Personajes enfermizos', value: '646' },
        { label: 'Iniciar sesión / Sign In', value: '811' },
        { label: 'Lenguaje de señas', value: '647' },
        { label: 'Siheyuan', value: '820' },
        { label: 'Simulador', value: '786' },
        { label: 'Cantantes', value: '648' },
        { label: 'Un solo interés amoroso femenino', value: '787' },
        { label: 'Padre soltero', value: '649' },
        { label: 'Complejo de hermana', value: '650' },
        { label: 'Asimilación de habilidades', value: '651' },
        { label: 'Libros de habilidades', value: '652' },
        { label: 'Creación de habilidades', value: '653' },
        { label: 'Harén de esclavas', value: '654' },
        { label: 'Protagonista esclavo', value: '655' },
        { label: 'Esclavos', value: '656' },
        { label: 'Sueño / Dormir', value: '657' },
        { label: 'Crecimiento lento al inicio', value: '658' },
        { label: 'Romance lento', value: '659' },
        { label: 'Pareja inteligente', value: '660' },
        { label: 'Marginados sociales', value: '661' },
        { label: 'Soldados', value: '662' },
        { label: 'Poder del alma', value: '663' },
        { label: 'Almas', value: '664' },
        { label: 'Manipulación espacial', value: '665' },
        { label: 'Usuario de lanza', value: '666' },
        { label: 'Habilidades especiales', value: '667' },
        { label: 'Espías', value: '668' },
        { label: 'Espíritu consejero', value: '669' },
        { label: 'Usuarios de espíritus', value: '670' },
        { label: 'Espíritus', value: '671' },
        { label: 'Resurgimiento del Qi / Energía espiritual', value: '828' },
        { label: 'Acosadores', value: '672' },
        { label: 'Star Wars', value: '817' },
        { label: 'SÍndrome de Estocolmo', value: '673' },
        { label: 'Personajes estoicos', value: '674' },
        { label: 'Dueño de tienda', value: '675' },
        { label: 'Seme heterosexual', value: '676' },
        { label: 'Uke heterosexual', value: '677' },
        { label: 'Batallas estratégicas', value: '678' },
        { label: 'Estratega', value: '679' },
        { label: 'Jerarquía basada en la fuerza', value: '680' },
        { label: 'Intereses amorosos fuertes', value: '681' },
        { label: 'De fuerte a más fuerte', value: '682' },
        { label: 'Protagonista terco', value: '683' },
        { label: 'Consejo estudiantil', value: '684' },
        { label: 'Relación estudiante-profesor', value: '685' },
        { label: 'Súcubo', value: '686' },
        { label: 'Aumento repentino de fuerza', value: '687' },
        { label: 'Riqueza repentina', value: '688' },
        { label: 'Suicidios', value: '689' },
        { label: 'Héroe invocado', value: '690' },
        { label: 'Magia de invocación', value: '691' },
        { label: 'Supervivencia', value: '692' },
        { label: 'Juego de supervivencia', value: '693' },
        { label: 'Swallowed Star', value: '785' },
        { label: 'Espada y magia', value: '694' },
        { label: 'Usuario de espada', value: '695' },
        { label: 'Sistema', value: '696' },
        { label: 'Profesores', value: '697' },
        { label: 'Trabajo en equipo', value: '698' },
        { label: 'Brecha tecnológica', value: '699' },
        { label: 'Tentáculos', value: '700' },
        { label: 'Enfermedad terminal', value: '701' },
        { label: 'Gestión de territorio', value: '802' },
        { label: 'Terroristas', value: '702' },
        { label: 'Ladrones', value: '703' },
        { label: 'Romance de los Tres Reinos', value: '795' },
        { label: 'Trío', value: '704' },
        { label: 'Suspenso / Thriller', value: '705' },
        { label: 'Bucle temporal', value: '706' },
        { label: 'Manipulación del tiempo', value: '707' },
        { label: 'Paradoja temporal', value: '708' },
        { label: 'Salto temporal', value: '709' },
        { label: 'Viaje en el tiempo', value: '710' },
        { label: 'Protagonista tímido', value: '711' },
        { label: 'Protagonista femenina marimacho', value: '712' },
        { label: 'Tortura', value: '713' },
        { label: 'Juguetes', value: '714' },
        { label: 'Pasado trágico', value: '715' },
        { label: 'Habilidad de transformación', value: '716' },
        { label: 'Transmigración', value: '717' },
        { label: 'Memorias trasplantadas', value: '718' },
        { label: 'Transportado a un mundo de juego', value: '719' },
        { label: 'Estructura moderna transportada', value: '720' },
        { label: 'Transportado a otro mundo', value: '721' },
        { label: 'Trampa / Trap', value: '722' },
        { label: 'Sociedad tribal', value: '723' },
        { label: 'Engañador / Trickster', value: '724' },
        { label: 'Tsundere', value: '725' },
        { label: 'Gemelos', value: '726' },
        { label: 'Personalidad retorcida', value: '727' },
        { label: 'Protagonista feo', value: '728' },
        { label: 'De feo a hermoso', value: '729' },
        { label: 'Amor incondicional', value: '730' },
        { label: 'Protagonista no-muerto', value: '810' },
        { label: 'Protagonista subestimado', value: '731' },
        { label: 'Técnica de cultivo única', value: '732' },
        { label: 'Usuario de arma única', value: '733' },
        { label: 'Armas únicas', value: '734' },
        { label: 'Flujo ilimitado / Unlimited flow', value: '735' },
        { label: 'Protagonista desafortunado', value: '736' },
        { label: 'Narrador no confiable', value: '737' },
        { label: 'Amor no correspondido', value: '738' },
        { label: 'Valquirias', value: '739' },
        { label: 'Vampiros', value: '740' },
        { label: 'Chicas nobles villanas', value: '741' },
        { label: 'Realidad virtual', value: '742' },
        { label: 'Vocaloid', value: '743' },
        { label: 'Actores de voz', value: '744' },
        { label: 'Voyeurismo', value: '745' },
        { label: 'Camareros', value: '746' },
        { label: 'Registros de guerra', value: '747' },
        { label: 'Warhammer', value: '775' },
        { label: 'Guerras', value: '748' },
        { label: 'Protagonista débil', value: '749' },
        { label: 'De débil a fuerte', value: '750' },
        { label: 'Personajes adinerados', value: '751' },
        { label: 'Bestias cambio de forma', value: '752' },
        { label: 'Nombres occidentales', value: '788' },
        { label: 'Deseos', value: '753' },
        { label: 'Witcher', value: '819' },
        { label: 'Brujas', value: '754' },
        { label: 'Magos', value: '755' },
        { label: 'Salto entre mundos', value: '756' },
        { label: 'Viaje por el mundo', value: '757' },
        { label: 'Árbol del mundo', value: '758' },
        { label: 'Escritores', value: '759' },
        { label: 'Yandere', value: '760' },
        { label: 'Youkai', value: '761' },
        { label: 'Hermanos menores', value: '762' },
        { label: 'Intereses amorosos más jóvenes', value: '763' },
        { label: 'Hermanas menores', value: '764' },
        { label: 'Yu-Gi-Oh!', value: '774' },
        { label: 'Zombis', value: '765' },
      ],
    },

    folders: {
      value: '',
      label: 'Carpetas de biblioteca',
      options: [
        { label: 'Sin filtro', value: '' },
        { label: 'Leyendo', value: '1' },
        { label: 'Leer más tarde', value: '2' },
        { label: 'Completado', value: '3' },
        { label: 'Papelera', value: '5' },
      ],
      type: FilterTypes.Picker,
    },
    library_exclude: {
      value: '',
      label: 'Excluir de la biblioteca',
      options: [
        { label: 'Ninguno', value: '' },
        { label: 'Excluir todo', value: 'history' },
        { label: 'Excluir papelera', value: 'trash' },
        { label: 'Excluir biblioteca y papelera', value: 'in_library' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

type NovelJson = {
  props: Props;
  page: string;
  query?: { raw_id: number };
};

type Props = {
  pageProps: PageProps;
  __N_SSP: boolean;
};

type PageProps = {
  serie: Serie;
  server_time: Date;
};

type Serie = {
  serie_data: SerieData;
  chapter: Chapter;
  recommendation: SerieData[];
  chapter_data: ChapterData;
  id: number;
  raw_id: number;
  slug: string;
  data: Data;
  is_default: boolean;
  raw_type: string;
};

type Chapter = {
  serie_id: number;
  id: number;
  raw_id: number;
  order: number;
  slug: string;
  title: string;
  name: string;
  created_at: string;
  updated_at: string;
};
type ApiChapter = {
  serie_id: number;
  id: number;
  order: number;
  title: string;
  name: string;
  updated_at: string;
};

type ChapterData = {
  data: ChapterContent;
};
type ChapterContent = {
  title: string;
  body: string;
  glossary_data?: {
    terms: string[][];
  };
};

type SerieData = {
  serie_id?: number;
  recommendation_id?: number;
  score?: string;
  id: number;
  slug: string;
  search_text: string;
  status: number;
  data: Data;
  created_at: string;
  updated_at: string;
  view: number;
  in_library: number;
  rating: number | null;
  chapter_count: number;
  power: number;
  total_rate: number;
  user_status: number;
  verified: boolean;
  from: null;
  raw_id: number;
  genres?: number[];
};

type Data = {
  title: string;
  author: string;
  description: string;
  image: string;
};

type JsonNovel = {
  success: boolean;
  data: Datum[];
};
type Datum = {
  serie: Serie;
  chapters: Chapter[];
  updated_at: Date;
  raw_id: number;
  slug: string;
  data: Data;
};

export default new WTRLABES();
