"""供 Python 模块启动、sidecar 调用和 Windows 单文件打包使用的入口。"""

from documentcraft.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
