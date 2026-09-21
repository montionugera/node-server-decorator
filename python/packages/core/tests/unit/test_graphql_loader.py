import asyncio

import pytest

from server_decorator import (
    batch_load,
    create_graphql_loader_context,
    graphql_loader,
)


class TestGraphQLDataLoaderAdapter:
    @pytest.mark.asyncio
    async def test_coalesces_scalar_lookups_across_50_items_into_single_batch(self):
        db_queries = []

        class BookService:
            async def batch_find_authors(self, ids: list[str]) -> list[dict[str, str]]:
                db_queries.append(f"SELECT * FROM authors WHERE id IN ({','.join(ids)})")
                return [{"id": a_id, "name": f"Author {a_id}"} for a_id in ids]

            @batch_load(batch_method="batch_find_authors")
            async def get_author_by_id(self, author_id: str) -> dict[str, str]: ...

        service = BookService()

        author_resolver = graphql_loader(
            service=service,
            method="get_author_by_id",
            key=lambda book: book.get("author_id"),
        )(lambda *args, **kwargs: None)

        ctx = create_graphql_loader_context()

        # 50 books with 10 distinct authors
        books = [{"id": f"b-{i}", "author_id": f"auth-{i % 10}"} for i in range(50)]

        results = await asyncio.gather(*(author_resolver(book, info=None) for book in books))

        assert len(results) == 50
        assert results[0] == {"id": "auth-0", "name": "Author auth-0"}
        assert results[49] == {"id": "auth-9", "name": "Author auth-9"}

        # Coalesced into 1 DB query!
        assert len(db_queries) == 1
        assert "SELECT * FROM authors WHERE id IN" in db_queries[0]

        await ctx["cleanup_loaders"]()

    @pytest.mark.asyncio
    async def test_coalesces_1_to_many_relation_lookups(self):
        db_queries = []

        class BookService:
            async def batch_find_books(self, author_ids: list[str]) -> list[dict[str, str]]:
                ids_str = ",".join(author_ids)
                db_queries.append(f"SELECT * FROM books WHERE author_id IN ({ids_str})")
                res = []
                for a_id in author_ids:
                    res.append(
                        {"id": f"b-1-{a_id}", "author_id": a_id, "title": f"Book 1 of {a_id}"}
                    )
                    res.append(
                        {"id": f"b-2-{a_id}", "author_id": a_id, "title": f"Book 2 of {a_id}"}
                    )
                return res

            @batch_load(
                batch_method="batch_find_books",
                key_of=lambda b: b["author_id"],
                relation="many",
            )
            async def get_books_by_author(self, author_id: str) -> list[dict[str, str]]: ...

        service = BookService()

        books_resolver = graphql_loader(
            service=service,
            method="get_books_by_author",
            key=lambda author: author["id"],
            is_list=True,
        )(lambda *args, **kwargs: None)

        ctx = create_graphql_loader_context()

        authors = [{"id": "a-1"}, {"id": "a-2"}, {"id": "a-3"}]
        results = await asyncio.gather(*(books_resolver(a, info=None) for a in authors))

        assert len(results) == 3
        assert len(results[0]) == 2
        assert results[0][0]["title"] == "Book 1 of a-1"

        assert len(db_queries) == 1

        await ctx["cleanup_loaders"]()

    @pytest.mark.asyncio
    async def test_request_isolation(self):
        class BookService:
            async def batch_find_authors(self, ids: list[str]) -> list[dict[str, str]]:
                return [{"id": a_id, "name": f"Author {a_id}"} for a_id in ids]

            @batch_load(batch_method="batch_find_authors")
            async def get_author_by_id(self, author_id: str) -> dict[str, str]: ...

        service = BookService()
        author_resolver = graphql_loader(
            service=service,
            method="get_author_by_id",
            key=lambda book: book.get("author_id"),
        )(lambda *args, **kwargs: None)

        ctx_a = create_graphql_loader_context()
        res_a = await author_resolver({"id": "b-1", "author_id": "auth-A"})
        await ctx_a["cleanup_loaders"]()

        ctx_b = create_graphql_loader_context()
        res_b = await author_resolver({"id": "b-2", "author_id": "auth-B"})
        await ctx_b["cleanup_loaders"]()

        assert res_a == {"id": "auth-A", "name": "Author auth-A"}
        assert res_b == {"id": "auth-B", "name": "Author auth-B"}
