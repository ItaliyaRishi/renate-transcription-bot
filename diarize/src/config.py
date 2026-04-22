from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    diarize_port: int = 8000
    log_level: str = "info"

    hf_token: str = ""

    s3_endpoint: str = "http://minio:9000"
    s3_region: str = "us-east-1"
    s3_access_key: str = "minioadmin"
    s3_secret_key: str = "minioadmin"
    s3_bucket_audio: str = "renate-audio"
    s3_force_path_style: bool = True


def load_settings() -> Settings:
    return Settings()
