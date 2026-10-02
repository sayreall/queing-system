import openpyxl
from openpyxl.worksheet.datavalidation import DataValidation

wb = openpyxl.Workbook()
ws = wb.active
ws.title = 'Players'

# Headers
ws.append(['Name', 'Skill', 'Rating', 'Gender'])

# Sample data
ws.append(['John Doe', 'Beginner', 2.50, 'Male'])
ws.append(['Jane Smith', 'Advanced', 4.25, 'Female'])
ws.append(['Bob Johnson', 'Intermediate', 3.50, 'Unspecified'])

# Data validation for Skill (B2:B1000)
dv_skill = DataValidation(type='list', formula1='"Beginner,Intermediate,Advanced"', allow_blank=True)
ws.add_data_validation(dv_skill)
dv_skill.add('B2:B1000')

# Data validation for Gender (D2:D1000)
dv_gender = DataValidation(type='list', formula1='"Male,Female,Unspecified"', allow_blank=True)
ws.add_data_validation(dv_gender)
dv_gender.add('D2:D1000')

# Make columns a bit wider
ws.column_dimensions['A'].width = 25
ws.column_dimensions['B'].width = 15
ws.column_dimensions['C'].width = 12
ws.column_dimensions['D'].width = 15

wb.save('import-template.xlsx')
print('Done!')
