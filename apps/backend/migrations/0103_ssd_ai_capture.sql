-- SSD labels are now AI-scannable: the same scan pipeline that reads RAM
-- labels already carries an SSD prompt/normalizer, so flipping the category
-- flag is all the backend needs.
UPDATE categories SET ai_capture = TRUE WHERE id = 'SSD';
