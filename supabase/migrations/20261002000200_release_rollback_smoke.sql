-- SPC-0020: intentionally failing migration to test the automatic rollback. Must never be merged for real.
select 1 / 0;
