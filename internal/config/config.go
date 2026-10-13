package config

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

type Config struct {
	Origin     string
	DataDir    string
	Listen     string
	Dev        bool
	IdentityOn bool
	RegOpen    bool

	SMTPConfigFile string

	S3Endpoint, S3Region, S3AccessKey, S3SecretKey string
	BucketOriginals, BucketDerived                  string

	ReplicaEndpoint, ReplicaRegion, ReplicaAccessKey, ReplicaSecretKey, ReplicaBucket string

	CDNBase                           string
	EOSecretID, EOSecretKey, EOZoneID string

	UploadMaxMB int   // 默认 60
	MaxPixels   int64 // 默认 100_000_000
	QuotaPhotos int   // 默认 2000
	Workers     int   // 默认 2
}

func Load(environ []string) (Config, error) {
	env := map[string]string{}
	for _, kv := range environ {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			env[kv[:i]] = kv[i+1:]
		}
	}
	cfg := Config{
		DataDir: env["MARKR_DATA_DIR"],
		Listen:  defaultStr(env["MARKR_LISTEN"], "127.0.0.1:18150"),
		Dev:     env["MARKR_DEV"] == "1",
	}
	if cfg.DataDir == "" {
		return cfg, fmt.Errorf("MARKR_DATA_DIR is required")
	}

	// Validate and canonicalize MARKR_ORIGIN
	originStr := env["MARKR_ORIGIN"]
	if originStr == "" {
		return cfg, fmt.Errorf("MARKR_ORIGIN is required")
	}
	u, err := url.Parse(originStr)
	if err != nil || u.Hostname() == "" {
		return cfg, fmt.Errorf("MARKR_ORIGIN invalid")
	}

	// Reject non-origins: userinfo, path, query, fragment, ForceQuery, Opaque
	if u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery || u.Opaque != "" {
		return cfg, fmt.Errorf("MARKR_ORIGIN must be an exact origin")
	}

	// Validate scheme and dev exception
	if u.Scheme != "https" {
		allowed := cfg.Dev && u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1")
		if !allowed {
			return cfg, fmt.Errorf("MARKR_ORIGIN must use https (dev localhost http allowed with MARKR_DEV=1)")
		}
	}

	// Store canonical form: scheme://lowercase-host[:port]
	cfg.Origin = strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)

	cfg.IdentityOn = env["MARKR_IDENTITY_ENABLED"] == "true"
	cfg.RegOpen = env["MARKR_REGISTRATION_OPEN"] == "true"
	cfg.SMTPConfigFile = env["MARKR_SMTP_CONFIG_FILE"]
	cfg.S3Endpoint, cfg.S3Region = env["MARKR_S3_ENDPOINT"], env["MARKR_S3_REGION"]
	cfg.S3AccessKey, cfg.S3SecretKey = env["MARKR_S3_ACCESS_KEY"], env["MARKR_S3_SECRET_KEY"]
	cfg.BucketOriginals, cfg.BucketDerived = env["MARKR_BUCKET_ORIGINALS"], env["MARKR_BUCKET_DERIVED"]
	cfg.ReplicaEndpoint, cfg.ReplicaRegion = env["MARKR_REPLICA_ENDPOINT"], env["MARKR_REPLICA_REGION"]
	cfg.ReplicaAccessKey, cfg.ReplicaSecretKey = env["MARKR_REPLICA_ACCESS_KEY"], env["MARKR_REPLICA_SECRET_KEY"]
	cfg.ReplicaBucket = env["MARKR_REPLICA_BUCKET"]
	cfg.CDNBase = strings.TrimRight(env["MARKR_CDN_BASE"], "/")
	cfg.EOSecretID, cfg.EOSecretKey, cfg.EOZoneID = env["MARKR_EO_SECRET_ID"], env["MARKR_EO_SECRET_KEY"], env["MARKR_EO_ZONE_ID"]

	var intErr error
	if cfg.Workers, intErr = intOr(env["MARKR_WORKERS"], "MARKR_WORKERS", 2); intErr != nil {
		return cfg, intErr
	}
	if cfg.UploadMaxMB, intErr = intOr(env["MARKR_UPLOAD_MAX_MB"], "MARKR_UPLOAD_MAX_MB", 60); intErr != nil {
		return cfg, intErr
	}
	if cfg.QuotaPhotos, intErr = intOr(env["MARKR_QUOTA_PHOTOS"], "MARKR_QUOTA_PHOTOS", 2000); intErr != nil {
		return cfg, intErr
	}
	mp, intErr := intOr(env["MARKR_MAX_PIXELS"], "MARKR_MAX_PIXELS", 100_000_000)
	if intErr != nil {
		return cfg, intErr
	}
	cfg.MaxPixels = int64(mp)
	return cfg, nil
}

func intOr(v string, key string, d int) (int, error) {
	if v == "" {
		return d, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s: invalid positive integer %q", key, v)
	}
	return n, nil
}

func defaultStr(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

func (c Config) Redacted() map[string]string {
	return map[string]string{"origin": c.Origin, "listen": c.Listen, "dev": strconv.FormatBool(c.Dev)}
}
