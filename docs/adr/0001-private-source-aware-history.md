# ADR 0001: Private source-aware project history

Lifecycle: current

Status: Accepted

## Context

A maintainer's project spans repository, package, website and search resources.
Those APIs have different retention windows, aggregation rules and permissions.
A new visitor tracker is not necessary to preserve their existing measurements.

## Decision

Use a portable TypeScript core, explicit metric definitions, source-scoped
observations and durable collection coverage. Store privately in local SQLite
or Cloudflare D1. Provide a CLI and read-only API plus a small dashboard. Keep
credentials in the operator environment and provider requests on an allowlist.
Use staged rows and fenced publication so failed collection cannot corrupt
previously valid history. Reuse existing extraction ideas, not contributor
profiling or a generic raw-data warehouse.

## Consequences

The product is useful with one resource and gains context from additional
sources. It cannot reconstruct individual journeys or equate downloads with
humans. Costs and supported datasets depend on the actual account. Publishing
the code does not publish private metrics. A small explicit adapter is preferable
to an unbounded plugin system until real use justifies further abstraction.
