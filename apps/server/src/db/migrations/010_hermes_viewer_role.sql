-- The company Hermes's page (spec 2026-10-03-pagina-do-hermes-da-empresa-design.md §1; src/companyHermes/).
-- Never edit after merge.
-- viewer_role_id: the role whose members see the company Hermes's page besides the owner (NULL: the
--   owner alone). GhostLink's alone: it never goes to the Hermes in hermes.config. Deleting the role
--   sets it back to NULL.
ALTER TABLE company_hermes ADD COLUMN viewer_role_id TEXT REFERENCES roles(id) ON DELETE SET NULL;
