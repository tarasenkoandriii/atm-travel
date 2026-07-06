-- ОРБИТА-Гид · pgvector RAG. Выполнить один раз в Supabase SQL Editor.
-- ВАЖНО: VECTOR_DIM (здесь 1024 — под BGE-M3) должен совпадать с EMBEDDINGS_DIM в env.
-- Если возьмёте OpenAI text-embedding-3-small — поставьте 1536 и здесь, и в env.

create extension if not exists vector;

-- Векторный индекс туров (отдельно от Prisma-таблицы "HotTour", чтобы не ломать миграции).
create table if not exists tour_embeddings (
  tour_id     text primary key,
  embedding   vector(1024),
  embed_hash  text not null,
  model_id    text,
  embedded_at timestamptz default now()
);

-- ANN-индекс (cosine). Пересоздать после массовой (пере)загрузки для оптимальных lists.
create index if not exists tour_emb_ann on tour_embeddings using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Гибридный поиск: RRF-слияние векторного KNN и полнотекста (websearch), только по активным турам.
-- Возвращает id туров, отранжированные по RRF, с учётом фильтров цены/звёзд.
create or replace function search_tours(
  query_embedding vector(1024),
  query_text      text,
  max_price       numeric default null,
  min_stars       int     default null,
  k               int     default 5
) returns table(tour_id text, rrf double precision)
language sql stable as $$
  with base as (
    select t."id" as id,
           t."priceUAH" as price,
           t."hotelStars" as stars,
           to_tsvector('simple',
             coalesce(t."destinationCity",'')||' '||coalesce(t."destinationCountry",'')||' '||
             coalesce(t."hotelName",'')||' '||coalesce(t."boardType",'')) as tsv
    from "HotTour" t
    where t."active" = true
      and (max_price is null or t."priceUAH" <= max_price)
      and (min_stars is null or t."hotelStars" >= min_stars)
  ),
  vec as (
    select e.tour_id as id,
           row_number() over (order by e.embedding <=> query_embedding) as rnk
    from tour_embeddings e
    join base b on b.id = e.tour_id
    order by e.embedding <=> query_embedding
    limit 40
  ),
  fts as (
    select b.id,
           row_number() over (order by ts_rank(b.tsv, websearch_to_tsquery('simple', coalesce(query_text,''))) desc) as rnk
    from base b
    where query_text is not null and query_text <> ''
      and b.tsv @@ websearch_to_tsquery('simple', query_text)
    limit 40
  )
  select id as tour_id,
         sum(1.0 / (60 + rnk)) as rrf
  from (
    select id, rnk from vec
    union all
    select id, rnk from fts
  ) u
  group by id
  order by rrf desc
  limit k;
$$;

-- Индексируемый полнотекст (§I.6): выражение совпадает с tsv в search_tours, поэтому индекс задействуется.
-- Создаётся вне Prisma; если db push его снесёт при drift — просто выполните этот файл повторно.
create index if not exists hot_tour_fts on "HotTour"
  using gin (to_tsvector('simple',
    coalesce("destinationCity",'')||' '||coalesce("destinationCountry",'')||' '||
    coalesce("hotelName",'')||' '||coalesce("boardType",'')));
