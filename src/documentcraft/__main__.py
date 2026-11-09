"""供 Python 模块启动和 Windows 单文件打包使用的入口。"""

import sys

from documentcraft.cli import main


if __name__ == "__main__":
    if len(sys.argv) > 1:
        raise SystemExit(main())

    from documentcraft.gui import launch

    launch()
