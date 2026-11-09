"""运行已经接入正式模块的阅读器，供既有 Spike 验证脚本调用。"""

from documentcraft.reader import main, open_reader

__all__ = ["main", "open_reader"]

if __name__ == "__main__":
    main()
