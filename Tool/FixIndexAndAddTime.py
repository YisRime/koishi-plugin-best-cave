import os
import json
from datetime import datetime, timezone

# --- 配置 ---
# 请根据你的实际情况修改这些路径
# 输入的 JSON 文件路径
input_json_path = 'cave_export.json'
# 输出更新后的 JSON 文件路径
output_json_path = 'cave_export_updated.json'
# 包含媒体文件的目录路径
media_dir = 'cave'
# --- 配置结束 ---


def convert_iso_to_ms_timestamp(iso_string: str) -> int:
    """
    将 ISO 8601 时间戳字符串 (以 'Z' 结尾表示UTC)
    转换为毫秒级的 Unix 时间戳。
    """
    # 为了兼容旧版 Python，将 'Z' 替换为 '+00:00'
    if iso_string.endswith('Z'):
        iso_string = iso_string[:-1] + '+00:00'

    dt_object = datetime.fromisoformat(iso_string)

    # 确保 datetime 对象是时区感知的 (如果不是则设为UTC)
    if dt_object.tzinfo is None:
        dt_object = dt_object.replace(tzinfo=timezone.utc)

    # 计算 Unix 时间戳 (秒) 并转换为毫秒
    return int(dt_object.timestamp() * 1000)


def rename_files_and_update_json(data: list, base_dir: str):
    """
    重命名文件并同步更新 JSON 数据中的文件名条目。
    """
    if not os.path.isdir(base_dir):
        print(f"错误: 找不到媒体文件目录 '{base_dir}'")
        return None

    print(f"开始处理目录: '{base_dir}'")
    total_renamed = 0
    total_skipped = 0
    updated_json_entries = 0

    # 遍历 JSON 数据中的每一条 cave
    for cave in data:
        try:
            # 从 cave 对象中提取元数据
            cave_id = cave['id']
            channel_id = cave.get('channelId', 'unknown')
            user_id = cave.get('userId', 'unknown')
            time_str = cave['time']

            # 将时间字符串转换为所需的毫秒时间戳
            timestamp_ms = convert_iso_to_ms_timestamp(time_str)

            media_index = 0
            entry_updated = False
            # 遍历 elements 列表以查找文件
            for element in cave.get('elements', []):
                # 检查是否为包含文件的媒体元素
                if 'file' in element and element.get('type') in ['image', 'video', 'audio', 'file', 'gif']:
                    media_index += 1  # 同一ID下多个文件的索引

                    old_filename = element['file']
                    _, extension = os.path.splitext(old_filename)

                    # 根据代码规范构建新的文件名
                    new_filename = f"{cave_id}-{media_index}_{channel_id}-{user_id}_{timestamp_ms}{extension}"

                    old_path = os.path.join(base_dir, old_filename)
                    new_path = os.path.join(base_dir, new_filename)

                    # 检查原始文件是否存在
                    if os.path.exists(old_path):
                        # 重命名文件
                        os.rename(old_path, new_path)
                        print(f"  成功: '{old_filename}' -> '{new_filename}'")
                        
                        # !!! 关键步骤: 更新 JSON 数据中对应的文件名
                        element['file'] = new_filename
                        entry_updated = True
                        total_renamed += 1
                    else:
                        print(f"  跳过: 原始文件未找到 '{old_filename}'")
                        total_skipped += 1
            
            if entry_updated:
                updated_json_entries += 1

        except KeyError as e:
            print(f"  警告: 因缺少键而跳过条目: {e}")
        except Exception as e:
            print(f"  错误: 处理条目 {cave.get('id', 'N/A')} 时发生意外错误: {e}")

    print("\n--- 处理完成 ---")
    print(f"成功重命名文件: {total_renamed} 个")
    print(f"成功更新 JSON 条目: {updated_json_entries} 条")
    print(f"跳过 (文件未找到): {total_skipped} 个")
    
    return data


if __name__ == "__main__":
    # 运行前检查输入文件和目录是否存在
    if not os.path.exists(input_json_path):
        print(f"错误: JSON 文件未找到 '{input_json_path}'")
    elif not os.path.isdir(media_dir):
        print(f"错误: 媒体目录未找到 '{media_dir}'")
    else:
        # 打开并加载 JSON 数据
        with open(input_json_path, 'r', encoding='utf-8') as f:
            cave_data = json.load(f)
        
        # 调用主函数执行重命名和更新操作
        updated_data = rename_files_and_update_json(cave_data, media_dir)

        # 如果成功处理，则将更新后的数据写入新文件
        if updated_data:
            with open(output_json_path, 'w', encoding='utf-8') as f:
                # 使用 indent 参数美化输出，ensure_ascii=False 确保中文等字符正确显示
                json.dump(updated_data, f, ensure_ascii=False, indent=4)
            print(f"\n已成功将更新后的数据保存到: '{output_json_path}'")