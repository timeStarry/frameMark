package seed

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/timeStarry/frameMark/internal/config"
	"github.com/timeStarry/frameMark/internal/jobs"
)

const (
	demoEmail = "markr-demo@invalid"

	maxFileBytes  = 5 << 20  // 5 MiB
	maxTotalBytes = 35 << 20 // 35 MiB

	demoNamespace = "markr-demo" // uuid v5 namespace for OwnerID
	jobProcess    = "process_photo"

	// Copied from internal/api/uploads.go:defaultPublicFields. The seed
	// snapshots the same defaults a user upload would get with no prefs row.
	defaultPublicFields = `["aperture","shutter","iso","focal_length"]`
)

var (
	// ErrInvalid is returned when the manifest, files, or images directory
	// fail validation. The whole run is rejected.
	ErrInvalid = errors.New("seed: invalid")
	// ErrConflict is returned when an existing row would be overwritten
	// with different content. The whole run is rejected with no writes.
	ErrConflict = errors.New("seed: conflict")
)

// Storage is the subset of object storage the seed uses: Put originals and
// Delete them if the transaction later fails.
type Storage interface {
	Put(ctx context.Context, bucket, key string, body []byte, contentType, cacheControl string) error
	Delete(ctx context.Context, bucket, key string) error
}

// Deps is everything Run needs besides the paths.
type Deps struct {
	DB      *sql.DB
	Storage Storage
	Cfg     config.Config
	Now     func() int64
}

// Report is the JSON plan printed by seed-demo. Created / Unchanged /
// Conflicts list "user:markr-demo", "photo:<manifest id>",
// "collection:<manifest id>".
type Report struct {
	Mode        string   `json:"mode"`
	Photos      int      `json:"photos"`
	Collections int      `json:"collections"`
	Created     []string `json:"created"`
	Unchanged   []string `json:"unchanged"`
	Conflicts   []string `json:"conflicts"`
}

type preparedPhoto struct {
	manifest photo
	uuid     string
	body     []byte
	format   string
	ctype    string
	key      string
	bytes    int64
}

type preparedCollection struct {
	manifest collection
	uuid     string
	cover    string
	featured sql.NullInt64
	photos   []string // photo uuids, manifest order
}

// demoNS is the uuid v5 namespace for every seed id: v5(DNS, "markr-demo").
var demoNS = uuid.NewSHA1(uuid.NameSpaceDNS, []byte(demoNamespace))

// OwnerID is the deterministic uuid v5 of namespace "markr-demo" and seed.
func OwnerID(seed string) string {
	return uuid.NewSHA1(demoNS, []byte(seed)).String()
}

// PhotoID is the deterministic uuid v5 of (seed, photo.id). The "photo"
// kind keeps it distinct from a collection with the same manifest id.
func PhotoID(seed, photoID string) string {
	return uuid.NewSHA1(demoNS, []byte(seed+"\x00photo\x00"+photoID)).String()
}

// CollectionID is the deterministic uuid v5 of (seed, collection.id).
func CollectionID(seed, collectionID string) string {
	return uuid.NewSHA1(demoNS, []byte(seed+"\x00collection\x00"+collectionID)).String()
}

// Run imports the demo seed described by the manifest at manifestPath,
// reading originals from imagesDir. apply=false is a dry run: validate,
// plan, write nothing. apply=true puts the new originals, then commits every
// row in one transaction; if that fails the objects that were put are
// deleted. On a conflict the report is returned with an ErrConflict error.
func Run(ctx context.Context, d Deps, manifestPath, imagesDir string, apply bool) (*Report, error) {
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, err
	}
	m, err := parseManifest(raw)
	if err != nil {
		return nil, err
	}
	imagesRoot, err := resolveImagesDir(imagesDir)
	if err != nil {
		return nil, err
	}
	photos, err := loadPhotos(imagesRoot, m)
	if err != nil {
		return nil, err
	}
	owner := OwnerID(m.Seed)
	colls := prepareCollections(m, photos)
	pl, err := inspect(ctx, d.DB, owner, photos, colls)
	if err != nil {
		return nil, err
	}
	r := pl.report(len(photos), len(colls))
	r.Mode = "dry-run"
	if apply {
		r.Mode = "apply"
	}
	if len(r.Conflicts) > 0 {
		return r, fmt.Errorf("%w: %s", ErrConflict, strings.Join(r.Conflicts, ", "))
	}
	if !apply || len(r.Created) == 0 {
		return r, nil
	}
	if err := applySeed(ctx, d, owner, m, photos, colls, pl); err != nil {
		return nil, err
	}
	return r, nil
}

func resolveImagesDir(imagesDir string) (string, error) {
	if imagesDir == "" {
		return "", invalid("images directory is required")
	}
	// Clean first: a trailing slash (or "/.") would make Lstat follow a
	// symlinked final component and so hide it.
	root, err := filepath.Abs(filepath.Clean(imagesDir))
	if err != nil {
		return "", err
	}
	st, err := os.Lstat(root)
	if err != nil {
		if os.IsNotExist(err) {
			return "", invalid("images directory %s does not exist", imagesDir)
		}
		return "", err
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return "", invalid("images directory must not be a symlink")
	}
	if !st.IsDir() {
		return "", invalid("images path is not a directory")
	}
	return root, nil
}

func loadPhotos(root string, m *manifest) ([]preparedPhoto, error) {
	out := make([]preparedPhoto, 0, len(m.Photos))
	var total int64
	for _, ph := range m.Photos {
		body, err := readImage(root, ph.File)
		if err != nil {
			return nil, err
		}
		n := int64(len(body))
		if n == 0 || n > maxFileBytes {
			return nil, invalid("each source image must be at most 5 MiB")
		}
		total += n
		if total > maxTotalBytes {
			return nil, invalid("source image total must be at most 35 MiB")
		}
		sum := sha256.Sum256(body)
		if hex.EncodeToString(sum[:]) != ph.SHA256 {
			return nil, invalid("source checksum mismatch: %s", ph.ID)
		}
		format, ctype, err := sniffImage(body)
		if err != nil {
			return nil, invalid("%s: %v", ph.ID, err)
		}
		id := PhotoID(m.Seed, ph.ID)
		out = append(out, preparedPhoto{
			manifest: ph,
			uuid:     id,
			body:     body,
			format:   format,
			ctype:    ctype,
			key:      "o/" + OwnerID(m.Seed) + "/" + id,
			bytes:    n,
		})
	}
	return out, nil
}

// readImage opens a regular, non-symlink file whose basename is name,
// confined to root. The file is never followed if it is a symlink.
func readImage(root, name string) ([]byte, error) {
	if name != filepath.Base(name) || strings.Contains(name, "..") || strings.ContainsAny(name, `/\`) {
		return nil, invalid("invalid photo filename %q", name)
	}
	path := filepath.Join(root, name)
	st, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, invalid("missing image %s", name)
		}
		return nil, err
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return nil, invalid("image %s is a symlink", name)
	}
	if !st.Mode().IsRegular() {
		return nil, invalid("image %s is not a regular file", name)
	}
	f, err := openRegular(path, st)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	// Bound the read so a racing grow cannot fill memory.
	return io.ReadAll(io.LimitReader(f, maxFileBytes+1))
}

// openRegular opens path without following a symlink and confirms that the
// opened file is a regular file and the same file Lstat saw, so a swap
// between the Lstat and the open cannot redirect the read. O_NONBLOCK keeps
// a FIFO swapped in from blocking the open; it does not affect regular files.
func openRegular(path string, lst os.FileInfo) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, invalid("cannot open image %s: %v", filepath.Base(path), err)
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if !st.Mode().IsRegular() || !os.SameFile(st, lst) {
		f.Close()
		return nil, invalid("image %s changed while it was being read", filepath.Base(path))
	}
	return f, nil
}

func sniffImage(body []byte) (format, contentType string, err error) {
	ct := http.DetectContentType(body)
	switch ct {
	case "image/jpeg":
		return "jpeg", ct, nil
	case "image/png":
		return "png", ct, nil
	case "image/webp":
		return "webp", ct, nil
	}
	return "", "", fmt.Errorf("only JPEG, PNG and WebP source images are supported")
}

func prepareCollections(m *manifest, photos []preparedPhoto) []preparedCollection {
	byID := map[string]preparedPhoto{}
	for _, p := range photos {
		byID[p.manifest.ID] = p
	}
	coverID := m.Profile.Cover
	out := make([]preparedCollection, 0, len(m.Collections))
	for _, c := range m.Collections {
		pc := preparedCollection{
			manifest: c,
			uuid:     CollectionID(m.Seed, c.ID),
		}
		var minFeat *int
		for _, id := range c.Photos {
			p := byID[id]
			pc.photos = append(pc.photos, p.uuid)
			if p.manifest.FeaturedRank != nil {
				r := *p.manifest.FeaturedRank
				if minFeat == nil || r < *minFeat {
					minFeat = &r
				}
			}
		}
		if minFeat != nil {
			pc.featured = sql.NullInt64{Int64: int64(*minFeat), Valid: true}
		}
		if _, ok := byID[coverID]; ok && collectionContains(c.Photos, coverID) {
			pc.cover = byID[coverID].uuid
		} else {
			pc.cover = pc.photos[0]
		}
		out = append(out, pc)
	}
	return out
}

func collectionContains(ids []string, want string) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}

// querier is satisfied by *sql.DB and *sql.Tx.
type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

const (
	stateCreate    = "create"
	stateUnchanged = "unchanged"
	stateConflict  = "conflict"
)

// plan is the state of every seed item, keyed "user:…", "photo:…",
// "collection:…", in manifest order.
type plan struct {
	tags   []string
	states map[string]string
}

func (p *plan) add(tag, state string) {
	p.tags = append(p.tags, tag)
	p.states[tag] = state
}

func (p *plan) report(photos, colls int) *Report {
	r := &Report{Photos: photos, Collections: colls, Created: []string{}, Unchanged: []string{}, Conflicts: []string{}}
	for _, t := range p.tags {
		switch p.states[t] {
		case stateCreate:
			r.Created = append(r.Created, t)
		case stateUnchanged:
			r.Unchanged = append(r.Unchanged, t)
		default:
			r.Conflicts = append(r.Conflicts, t)
		}
	}
	return r
}

func (p *plan) equal(o *plan) bool {
	if len(p.tags) != len(o.tags) {
		return false
	}
	for _, t := range p.tags {
		if p.states[t] != o.states[t] {
			return false
		}
	}
	return true
}

func inspect(ctx context.Context, q querier, owner string, photos []preparedPhoto, colls []preparedCollection) (*plan, error) {
	pl := &plan{states: map[string]string{}}
	st, err := inspectUser(ctx, q, owner)
	if err != nil {
		return nil, err
	}
	pl.add("user:"+ownerName, st)
	for _, p := range photos {
		st, err := inspectPhoto(ctx, q, owner, p)
		if err != nil {
			return nil, err
		}
		pl.add("photo:"+p.manifest.ID, st)
	}
	// Photo uuids that already exist; a new photo has no frame yet, so it
	// is not expected among a collection's existing frames.
	existing := map[string]bool{}
	for _, p := range photos {
		if pl.states["photo:"+p.manifest.ID] != stateCreate {
			existing[p.uuid] = true
		}
	}
	for _, c := range colls {
		st, err := inspectCollection(ctx, q, owner, c, existing)
		if err != nil {
			return nil, err
		}
		pl.add("collection:"+c.manifest.ID, st)
	}
	return pl, nil
}

func inspectUser(ctx context.Context, db querier, owner string) (string, error) {
	var id, email string
	err := db.QueryRowContext(ctx, `SELECT id,email FROM users WHERE id=? OR email=?`, owner, demoEmail).Scan(&id, &email)
	if errors.Is(err, sql.ErrNoRows) {
		return stateCreate, nil
	}
	if err != nil {
		return "", err
	}
	if id != owner || email != demoEmail {
		return stateConflict, nil
	}
	// The user and its profile are created together; a user without one is
	// drift, reported as a conflict rather than repaired.
	var n int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM profiles WHERE user_id=?`, owner).Scan(&n); err != nil {
		return "", err
	}
	if n != 1 {
		return stateConflict, nil
	}
	return stateUnchanged, nil
}

func inspectPhoto(ctx context.Context, db querier, owner string, p preparedPhoto) (string, error) {
	var existingOwner, sha string
	err := db.QueryRowContext(ctx, `SELECT owner_id,original_sha256 FROM photos WHERE id=?`, p.uuid).Scan(&existingOwner, &sha)
	if errors.Is(err, sql.ErrNoRows) {
		// photos has UNIQUE(owner_id, original_sha256): the same bytes
		// under another id would make the insert fail.
		var other string
		err := db.QueryRowContext(ctx, `SELECT id FROM photos WHERE owner_id=? AND original_sha256=?`, owner, p.manifest.SHA256).Scan(&other)
		if errors.Is(err, sql.ErrNoRows) {
			return stateCreate, nil
		}
		if err != nil {
			return "", err
		}
		return stateConflict, nil
	}
	if err != nil {
		return "", err
	}
	if existingOwner == owner && sha == p.manifest.SHA256 {
		return stateUnchanged, nil
	}
	return stateConflict, nil
}

func inspectCollection(ctx context.Context, db querier, owner string, c preparedCollection, existing map[string]bool) (string, error) {
	var existingOwner, title, intro string
	err := db.QueryRowContext(ctx, `SELECT owner_id,title,intro FROM collections WHERE id=?`, c.uuid).Scan(&existingOwner, &title, &intro)
	if errors.Is(err, sql.ErrNoRows) {
		return stateCreate, nil
	}
	if err != nil {
		return "", err
	}
	if existingOwner != owner || title != c.manifest.Title || intro != c.manifest.Text {
		return stateConflict, nil
	}
	// Frames must still be the seeded ones: one full frame per already
	// existing photo, in manifest order. Any drift (a missing, extra or
	// reordered frame) is a conflict, never a silent repair.
	var want []string
	for _, pid := range c.photos {
		if existing[pid] {
			want = append(want, pid)
		}
	}
	var frames int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM frames WHERE collection_id=?`, c.uuid).Scan(&frames); err != nil {
		return "", err
	}
	if frames != len(want) {
		return stateConflict, nil
	}
	for i, pid := range want {
		var got string
		err := db.QueryRowContext(ctx, `SELECT fp.photo_id FROM frames f JOIN frame_photos fp ON fp.frame_id=f.id AND fp.slot=0
			WHERE f.collection_id=? AND f.position=? AND f.layout='full'`, c.uuid, i).Scan(&got)
		if errors.Is(err, sql.ErrNoRows) {
			return stateConflict, nil
		}
		if err != nil {
			return "", err
		}
		if got != pid {
			return stateConflict, nil
		}
	}
	return stateUnchanged, nil
}

func applySeed(ctx context.Context, d Deps, owner string, m *manifest, photos []preparedPhoto, colls []preparedCollection, pl *plan) (err error) {
	// Only new photos are put, so the cleanup below can never delete an
	// original that an existing row points at.
	var putKeys []string
	defer func() {
		if err == nil {
			return
		}
		// A failed tx leaves no rows, so the T14 cleanup would never find
		// these objects. Delete them even if ctx was cancelled.
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
		defer cancel()
		var errs []error
		for _, key := range putKeys {
			if derr := d.Storage.Delete(cctx, d.Cfg.BucketOriginals, key); derr != nil {
				errs = append(errs, fmt.Errorf("delete %s: %w", key, derr))
			}
		}
		err = errors.Join(append([]error{err}, errs...)...)
	}()
	for _, p := range photos {
		if pl.states["photo:"+p.manifest.ID] != stateCreate {
			continue
		}
		if err := d.Storage.Put(ctx, d.Cfg.BucketOriginals, p.key, p.body, p.ctype, ""); err != nil {
			return err
		}
		putKeys = append(putKeys, p.key)
	}

	tx, err := d.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Re-check under the write lock (BEGIN IMMEDIATE): another run may have
	// committed since the plan was made.
	again, err := inspect(ctx, tx, owner, photos, colls)
	if err != nil {
		return err
	}
	if !again.equal(pl) {
		return fmt.Errorf("%w: database changed during the run; retry", ErrConflict)
	}

	now := d.Now()
	if pl.states["user:"+ownerName] == stateCreate {
		if err := insertUser(ctx, tx, owner, m, now); err != nil {
			return err
		}
	}
	q := jobs.New(d.DB, d.Now)
	for _, p := range photos {
		if pl.states["photo:"+p.manifest.ID] != stateCreate {
			continue
		}
		if err := insertPhoto(ctx, tx, q, owner, p, now); err != nil {
			return err
		}
	}
	// published_at decreases with manifest order so the first manifest
	// collection is the newest (the square lists published_at DESC).
	for i, c := range colls {
		if pl.states["collection:"+c.manifest.ID] != stateCreate {
			continue
		}
		if err := insertCollection(ctx, tx, owner, c, i+1, now-int64(i), now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func insertUser(ctx context.Context, tx *sql.Tx, owner string, m *manifest, now int64) error {
	pw, err := impossiblePassword()
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO users(id,email,password,created_at) VALUES(?,?,?,?)`,
		owner, demoEmail, pw, now); err != nil {
		return err
	}
	layout := "salon"
	if m.Profile.Layout == "grid" {
		layout = "grid"
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO profiles(user_id,name,bio,wall_layout,updated_at) VALUES(?,?,?,?,?)`,
		owner, m.Profile.Name, m.Profile.Bio, layout, now)
	return err
}

// impossiblePassword is "!" plus 43 random characters (32 random bytes,
// unpadded base64url). It has no "$" and no scrypt-v1 prefix, so
// identity.VerifyPassword always fails for it, whatever is typed.
func impossiblePassword() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "!" + base64.RawURLEncoding.EncodeToString(b), nil
}

func insertPhoto(ctx context.Context, tx *sql.Tx, q *jobs.Queue, owner string, p preparedPhoto, now int64) error {
	salt := newSalt()
	_, err := tx.ExecContext(ctx, `INSERT INTO photos(id,owner_id,status,original_key,original_sha256,original_bytes,format,
		title,caption,public_fields,histogram_public,original_download,derived_salt,created_at,updated_at)
		VALUES(?,?,'processing',?,?,?,?,?,?,?,?,0,?,?,?)`,
		p.uuid, owner, p.key, p.manifest.SHA256, p.bytes, p.format,
		p.manifest.Title, p.manifest.Text, defaultPublicFields, 1, salt, now, now)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO attributions(photo_id,source) VALUES(?,?)`,
		p.uuid, string(p.manifest.Source)); err != nil {
		return err
	}
	_, err = q.EnqueueTx(ctx, tx, jobProcess, map[string]string{"photoId": p.uuid})
	return err
}

func insertCollection(ctx context.Context, tx *sql.Tx, owner string, c preparedCollection, wallRank int, publishedAt, now int64) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO collections(id,owner_id,title,intro,status,visibility,distribute,
		original_download,license,ai_declaration,cover_photo_id,featured_rank,wall_rank,published_at,created_at,updated_at)
		VALUES(?,?,?,?, 'published','public',1, 0, NULL, NULL, ?,?,?,?,?,?)`,
		c.uuid, owner, c.manifest.Title, c.manifest.Text,
		c.cover, c.featured, wallRank, publishedAt, now, now)
	if err != nil {
		return err
	}
	for i, pid := range c.photos {
		fid, err := newV7()
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO frames(id,collection_id,position,layout,matte_ratio,text) VALUES(?,?,?,'full',NULL,NULL)`,
			fid, c.uuid, i); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO frame_photos(frame_id,slot,photo_id) VALUES(?,0,?)`, fid, pid); err != nil {
			return err
		}
	}
	return nil
}

// newSalt is a random 16-byte hex derived_salt. Copied from
// internal/api/uploads.go:newSalt so media URLs cannot be computed from
// the original's sha256.
func newSalt() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func newV7() (string, error) {
	u, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	return u.String(), nil
}
